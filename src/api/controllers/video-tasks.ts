import db, {
  createVideoTask,
  findVideoTaskByIdempotency,
  getVideoTask,
  listRunningVideoTasks,
  updateVideoTask,
  type VideoTask,
} from "@/lib/database.ts";
import accountPool from "@/lib/account-pool.ts";
import logger from "@/lib/logger.ts";
import { executeWithCredentialFailover, type ResolvedCredential } from "./auth.ts";
import { generateVideoWithRetry, pollVideoResult } from "./videos.ts";
import { cacheVideoLocally, generateDoubaoVideo, isDoubaoVideoModel, resumeDoubaoVideo } from "./doubao-videos.ts";

export interface VideoTaskInput {
  authorization: string;
  ownerHash: string;
  idempotencyKey?: string;
  model: string;
  prompt: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
  filePaths?: string[];
  allowDowngrade?: boolean;
  baseOrigin?: string;
}

export interface VideoTaskResult {
  videoUrl: string;
  credential?: ResolvedCredential;
}

/** 本进程内正在执行的任务（同步请求等待它；幂等重复请求复用它） */
const running = new Map<string, Promise<VideoTaskResult>>();

function recordSuccess(task: VideoTask, videoUrl: string, statsKey: string) {
  updateVideoTask(task.id, { status: "succeeded", video_url: videoUrl, error: null });
  try {
    db.recordCall(statsKey, task.model, 0);
    db.saveMedia("video", videoUrl, task.model, task.prompt, statsKey);
  } catch (e: any) {
    logger.warn(`视频任务统计落库失败: ${e?.message || e}`);
  }
}

function recordFailure(task: VideoTask, error: any) {
  updateVideoTask(task.id, { status: "failed", error: String(error?.message || error || "视频生成失败").slice(0, 1000) });
}

/**
 * 创建并启动视频任务
 *
 * 同一调用方带相同 idempotencyKey 重复提交时返回已有任务，不会再次提交上游扣积分。
 */
export function startVideoTask(input: VideoTaskInput): { task: VideoTask; done: Promise<VideoTaskResult> } {
  const idempotencyKey = input.idempotencyKey?.trim().slice(0, 200) || null;
  if (idempotencyKey) {
    const existing = findVideoTaskByIdempotency(input.ownerHash, idempotencyKey);
    if (existing) return { task: existing, done: waitForTask(existing) };
  }

  const useDoubao = isDoubaoVideoModel(input.model);
  const provider = useDoubao ? "doubao" : "jimeng";
  let task: VideoTask;
  try {
    task = createVideoTask({
      owner_hash: input.ownerHash,
      idempotency_key: idempotencyKey,
      provider,
      model: input.model,
      prompt: input.prompt,
    });
  } catch (error: any) {
    // 并发的重复提交撞上唯一索引：复用先插入的那条
    const existing = idempotencyKey && String(error?.message).includes("UNIQUE")
      ? findVideoTaskByIdempotency(input.ownerHash, idempotencyKey)
      : undefined;
    if (!existing) throw error;
    return { task: existing, done: waitForTask(existing) };
  }

  const { ratio, resolution, duration, filePaths, allowDowngrade, baseOrigin } = input;
  // history_id 存上游任务标识：即梦为历史记录 ID，豆包为会话 ID
  const onSubmitted = (upstreamId: string) => updateVideoTask(task.id, { history_id: String(upstreamId) });
  const done = executeWithCredentialFailover(input.authorization, provider, (cred) => {
    updateVideoTask(task.id, { account_id: cred.accountId || null, account_name: cred.accountName || null });
    return useDoubao
      ? generateDoubaoVideo(input.model, input.prompt, { ratio, resolution, duration, filePaths, baseOrigin, onSubmitted }, cred.token)
      : generateVideoWithRetry(
          input.model,
          input.prompt,
          { ratio, resolution, duration, filePaths, allowDowngrade, baseOrigin, onSubmitted },
          cred.token
        );
  }).then(({ result, credential }) => {
    recordSuccess(task, result, credential.managedKey || credential.accountName || credential.token);
    return { videoUrl: result, credential };
  }, (error) => {
    recordFailure(task, error);
    throw error;
  });

  track(task.id, done);
  return { task, done };
}

function track(id: string, done: Promise<VideoTaskResult>) {
  running.set(id, done);
  // 异步模式下没人 await，吞掉拒绝避免 unhandledRejection；错误已写入任务表
  done.catch(() => undefined).finally(() => running.delete(id));
}

/** 等待已有任务完成（用于幂等重复的同步请求） */
function waitForTask(task: VideoTask): Promise<VideoTaskResult> {
  if (task.status === "succeeded") return Promise.resolve({ videoUrl: task.video_url! });
  if (task.status === "failed") return Promise.reject(new Error(task.error || "视频生成失败"));
  return running.get(task.id) || pollTaskTable(task.id);
}

/** 任务在跑但不在本进程内存中（例如正在恢复）：从任务表等待结果 */
async function pollTaskTable(id: string): Promise<VideoTaskResult> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const task = getVideoTask(id);
    if (!task) throw new Error("视频任务不存在");
    if (task.status === "succeeded") return { videoUrl: task.video_url! };
    if (task.status === "failed") throw new Error(task.error || "视频生成失败");
  }
}

export function getVideoTaskForOwner(id: string, ownerHash: string): VideoTask | undefined {
  const task = getVideoTask(id);
  return task && task.owner_hash === ownerHash ? task : undefined;
}

/** 对外返回的任务视图（不含内部字段） */
export function publicVideoTask(task: VideoTask) {
  return {
    id: task.id,
    object: "video.generation.task",
    status: task.status,
    model: task.model,
    url: task.video_url,
    error: task.error,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

/**
 * 服务启动时处理上次未完成的任务
 *
 * - 账号池任务且已拿到上游任务标识：用原账号继续轮询（不会重新提交）
 *   即梦按历史记录 ID，豆包按会话 ID
 * - 其他：标记失败，提示是否可能已提交上游
 */
export function resumeVideoTasks(): void {
  for (const task of listRunningVideoTasks()) {
    if (running.has(task.id)) continue;
    const isDoubao = task.provider === "doubao";
    const upstreamRef = isDoubao
      ? `豆包会话 https://www.doubao.com/chat/${task.history_id}`
      : `即梦历史ID ${task.history_id}`;
    if (task.history_id && task.account_id) {
      let selected: ReturnType<typeof accountPool.getCredential>;
      try {
        selected = accountPool.getCredential(task.account_id);
      } catch (error: any) {
        recordFailure(task, `服务重启后无法续查：${error?.message || error}（${upstreamRef}）`);
        continue;
      }
      logger.info(`恢复视频任务 ${task.id}，继续轮询${upstreamRef}`);
      accountPool.acquire(task.account_id);
      const resumed = isDoubao
        ? resumeDoubaoVideo(task.history_id, selected.credential)
        : pollVideoResult(task.history_id, selected.sessionId)
            .then((remoteUrl) => cacheVideoLocally(remoteUrl, undefined, "jimeng"));
      const done = resumed
        .then((videoUrl) => {
          recordSuccess(task, videoUrl, task.account_name || "recovered");
          return { videoUrl };
        }, (error) => {
          recordFailure(task, error);
          throw error;
        })
        .finally(() => accountPool.release(task.account_id!));
      track(task.id, done);
      continue;
    }
    recordFailure(
      task,
      task.history_id
        ? `服务重启导致任务中断，任务已提交上游（${upstreamRef}），请到网页端查看结果`
        : "服务重启导致任务中断，任务可能尚未提交上游，请重新提交"
    );
  }
}
