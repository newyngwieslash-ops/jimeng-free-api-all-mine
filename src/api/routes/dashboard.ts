import _ from 'lodash';
import fs from 'fs';
import mime from 'mime';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import { getCredit } from '@/api/controllers/core.ts';
import browserTransport from '@/lib/browser-transport.ts';
import { generateVideoWithRetry } from '@/api/controllers/videos.ts';
import {
  DEFAULT_DOUBAO_VIDEO_MODEL,
  DOUBAO_RATIOS,
  generateDoubaoVideo,
  isDoubaoVideoModel,
} from '@/api/controllers/doubao-videos.ts';
import { executeWithPoolFailover } from '@/api/controllers/auth.ts';
import logger from '@/lib/logger.ts';
import { cancelQrLogin, getQrLogin, inputQrLogin, screenshotQrLogin, startQrLogin } from '@/lib/qr-login.ts';

const STUDIO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

function sessionUser(request: Request): number | null {
  const sessionId = request.headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  return sessionId ? db.validateSession(sessionId) : null;
}

function authError(request: Request): Response | null {
  return sessionUser(request) ? null : new Response({ error: '未登录' }, { statusCode: 401 });
}

function keyId(request: Request): number | null {
  const id = Number(request.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default {
  prefix: '/dashboard',
  get: {
    '/status': async () => ({ setupComplete: db.isSetupComplete() }),
    '/stats': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.getStats();
    },
    '/logs': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.getLogs(request.query.level as string, parseInt(request.query.limit as string) || 100);
    },
    '/media': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.getMedia(parseInt(request.query.page as string) || 1, parseInt(request.query.limit as string) || 20, request.query.type as string);
    },
    '/credits': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const key = request.query.key as string;
      if (!key) return { error: '缺少Key参数' };
      try { return await getCredit(key); } catch (e) { return { error: '查询失败', message: e.message }; }
    },
    '/keys': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.listApiKeys();
    },
    '/settings': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return { browserTransport: await browserTransport.getStatus() };
    },
    '/qr-login/:id': async (request: Request) => {
      const error = authError(request); if (error) return error;
      try { return getQrLogin(String(request.params.id)); }
      catch (e: any) { return new Response({ error: e.message }, { statusCode: 404 }); }
    },
    '/qr-login/:id/screen': async (request: Request) => {
      const error = authError(request); if (error) return error;
      try {
        const image = await screenshotQrLogin(String(request.params.id));
        return new Response(image, { type: 'image/jpeg', headers: { 'Cache-Control': 'no-store' } });
      } catch (e: any) { return new Response({ error: e.message }, { statusCode: 410 }); }
    }
  },
  post: {
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      const { username, password } = request.body;
      if (!username || !password) return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      if (password.length < 6) return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },
    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      const sessionId = db.createSession(userId);
      return new Response({ success: true }, { statusCode: 200, headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` } });
    },
    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
      if (sessionId) db.deleteSession(sessionId);
      return new Response({ success: true }, { statusCode: 200, headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' } });
    },
    '/password': async (request: Request) => {
      const userId = sessionUser(request);
      if (!userId) return new Response({ error: '未登录' }, { statusCode: 401 });
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    },
    '/keys': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const name = typeof request.body?.name === 'string' ? request.body.name : '';
      const created = db.createApiKey(name);
      return { success: true, key: created.key, apiKey: created.apiKey };
    },
    '/keys/:id/status': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const id = keyId(request);
      if (!id || typeof request.body?.enabled !== 'boolean') return new Response({ error: '参数无效' }, { statusCode: 400 });
      const apiKey = db.setApiKeyEnabled(id, request.body.enabled);
      if (!apiKey) return new Response({ error: 'Key不存在' }, { statusCode: 404 });
      return { success: true, apiKey };
    },
    '/settings/browser-transport': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const mode = request.body?.mode;
      if (!['off', 'auto', 'always'].includes(mode))
        return new Response({ error: '模式参数无效' }, { statusCode: 400 });
      await browserTransport.setMode(mode);
      return { success: true, browserTransport: await browserTransport.getStatus() };
    },
    '/qr-login': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const provider = request.body?.provider;
      if (provider !== 'jimeng' && provider !== 'doubao') return new Response({ error: '平台参数无效' }, { statusCode: 400 });
      try {
        return await startQrLogin({
          provider,
          name: typeof request.body?.name === 'string' ? request.body.name : undefined,
          accountId: typeof request.body?.accountId === 'string' ? request.body.accountId : undefined,
        });
      } catch (e: any) {
        logger.error(`启动扫码登录失败: ${e.message}`);
        return new Response({ error: e.message }, { statusCode: 500 });
      }
    },
    '/qr-login/:id/input': async (request: Request) => {
      const error = authError(request); if (error) return error;
      try {
        await inputQrLogin(String(request.params.id), request.body || {});
        return { success: true };
      } catch (e: any) { return new Response({ error: e.message }, { statusCode: 400 }); }
    },
    '/video-generate': async (request: Request) => {
      const error = authError(request); if (error) return error;

      // ---- 参数解析（multipart form-data）----
      const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt.trim() : '';
      if (!prompt) return new Response({ error: '视频提示词不能为空' }, { statusCode: 400 });

      const selectedModel = typeof request.body?.model === 'string' && request.body.model.trim()
        ? request.body.model.trim()
        : DEFAULT_DOUBAO_VIDEO_MODEL;
      const useDoubao = isDoubaoVideoModel(selectedModel);
      const provider = useDoubao ? 'doubao' : 'jimeng';

      const duration = Number(request.body?.duration);
      const finalDuration = useDoubao
        ? (duration >= 8 ? 10 : 5)
        : (Number.isInteger(duration) && duration >= 4 && duration <= 15 ? duration : 5);

      const allowedRatios = useDoubao ? DOUBAO_RATIOS : STUDIO_RATIOS;
      const ratio = typeof request.body?.ratio === 'string' && allowedRatios.includes(request.body.ratio)
        ? request.body.ratio : '16:9';

      const files: any = request.files || {};
      const firstFile = files.first_frame || Object.values(files).find((f: any) => f?.fieldname === 'first_frame');
      const lastFile = files.last_frame || Object.values(files).find((f: any) => f?.fieldname === 'last_frame');
      if (lastFile?.filepath && !firstFile?.filepath) {
        return new Response({ error: '上传尾帧时请先上传首帧参考图' }, { statusCode: 400 });
      }

      const toDataUri = (file: any): string | null => {
        try {
          const buf = fs.readFileSync(file.filepath);
          const type = file.mimetype || file.type || mime.getType(file.originalFilename || file.newFilename || '') || 'image/png';
          return `data:${type};base64,${buf.toString('base64')}`;
        } catch (e: any) {
          logger.error(`读取上传参考图失败: ${e.message}`);
          return null;
        }
      };

      const filePaths: string[] = [];
      if (firstFile?.filepath) {
        const firstDataUri = toDataUri(firstFile);
        if (!firstDataUri) return new Response({ error: '首帧参考图读取失败' }, { statusCode: 400 });
        filePaths.push(firstDataUri);
      }
      if (!useDoubao && lastFile?.filepath) {
        const lastDataUri = toDataUri(lastFile);
        if (lastDataUri) filePaths.push(lastDataUri);
      }

      // ---- 账号池多账号故障切换生成 ----
      const startedAt = Date.now();
      let videoUrl: string;
      let accountName = '';
      const baseOrigin = request.headers?.host ? `http://${request.headers.host}` : undefined;
      try {
        const outcome = await executeWithPoolFailover(provider, (cred) =>
          useDoubao
            ? generateDoubaoVideo(selectedModel, prompt, { ratio, resolution: '720p', duration: finalDuration, filePaths, baseOrigin }, cred.token)
            : generateVideoWithRetry(selectedModel, prompt, { ratio, resolution: '720p', duration: finalDuration, filePaths, baseOrigin }, cred.token)
        );
        videoUrl = outcome.result;
        accountName = outcome.credential.accountName || '';
      } catch (e: any) {
        const msg = String(e?.message || '视频生成失败');
        if (msg.includes('没有可用的')) {
          return new Response(
            { error: `账号池无可用${useDoubao ? '豆包' : '即梦'}账号，请先在「账号池」添加并启用${useDoubao ? '豆包' : '即梦'}账号（或账号积分今日已用完、处于冷却中）` },
            { statusCode: 503 }
          );
        }
        if (e?.name === 'AccountBusyError') return new Response({ error: msg }, { statusCode: 503 });
        logger.error(`视频创作页生成失败 (${selectedModel}): ${msg}`);
        return new Response({ error: msg }, { statusCode: 502 });
      }

      // ---- 统计与媒体落库（复用媒体资源页）----
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const statsTag = `studio:${accountName || selectedModel}`;
      try {
        db.recordCall(statsTag, selectedModel, 0);
        if (videoUrl) db.saveMedia('video', videoUrl, selectedModel, prompt, statsTag);
      } catch (e: any) {
        logger.warn(`视频创作统计落库失败: ${e.message}`);
      }

      return {
        video_url: videoUrl,
        model: selectedModel,
        provider,
        account_name: accountName,
        duration: finalDuration,
        ratio,
        elapsed_seconds: elapsedSeconds
      };
    }
  },
  delete: {
    '/qr-login/:id': async (request: Request) => {
      const error = authError(request); if (error) return error;
      await cancelQrLogin(String(request.params.id));
      return { success: true };
    },
    '/logs': async (request: Request) => {
      const error = authError(request); if (error) return error;
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    },
    '/keys/:id': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const id = keyId(request);
      if (!id) return new Response({ error: '参数无效' }, { statusCode: 400 });
      if (!db.deleteApiKey(id)) return new Response({ error: 'Key不存在' }, { statusCode: 404 });
      return { success: true };
    }
  }
};
