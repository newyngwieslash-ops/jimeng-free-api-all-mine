import _ from 'lodash';
import fs from 'fs-extra';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import { resolveLocalVideoPath } from '@/api/controllers/doubao-videos.ts';
import { getVideoTaskForOwner, publicVideoTask, startVideoTask } from '@/api/controllers/video-tasks.ts';
import util from '@/lib/util.ts';
import db, { getVideoTask } from '@/lib/database.ts';

function localVideoPathFromUrl(url: string): string | null {
    const filename = url.match(/\/v1\/videos\/files\/([^/?#]+)$/)?.[1];
    return filename ? resolveLocalVideoPath(filename) : null;
}

function requestBaseOrigin(request: Request): string | undefined {
    const host = request.headers?.['x-forwarded-host'] || request.headers?.host;
    if (!host || typeof host !== 'string') return undefined;
    const proto = (request.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${host.split(',')[0].trim()}`;
}

function appendUploadedPaths(value: any, target: string[]) {
    if (!value) return;
    if (Array.isArray(value)) {
        value.forEach(item => appendUploadedPaths(item, target));
        return;
    }
    const path = value.filepath || value.path;
    if (typeof path === 'string' && path) target.push(path);
}

export default {

    prefix: '/v1/videos',

    get: {

        '/generations/:id': async (request: Request) => {
            request.validate('headers.authorization', _.isString);
            const task = getVideoTaskForOwner(
                String(request.params?.id || ''),
                db.taskOwnerHash(request.headers.authorization)
            );
            if (!task) return new Response({ error: '视频任务不存在' }, { statusCode: 404 });
            return publicVideoTask(task);
        },

        '/files/:filename': async (request: Request) => {
            const filename = String(request.params?.filename || '');
            const filePath = resolveLocalVideoPath(filename);
            if (!filePath || !(await fs.pathExists(filePath))) {
                return new Response({ error: '视频文件不存在' }, { statusCode: 404 });
            }
            const stat = await fs.stat(filePath);
            const headers: Record<string, string> = {
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                'ETag': `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
                'Last-Modified': stat.mtime.toUTCString()
            };
            if (request.query?.download === '1') {
                headers['Content-Disposition'] = `attachment; filename="${filename}"`;
            }
            return new Response(fs.createReadStream(filePath), {
                type: 'video/mp4',
                size: stat.size,
                headers
            });
        }

    },

    post: {

        '/generations': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => _.isUndefined(v) || _.isInteger(v))
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('body.async', v => _.isUndefined(v) || _.isBoolean(v))
                .validate('body.allow_downgrade', v => _.isUndefined(v) || _.isBoolean(v))
                .validate('body.idempotency_key', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration,
                file_paths = [],
                response_format = "url",
                async: asyncMode = false,
                allow_downgrade: allowDowngrade = false,
            } = request.body;
            // 客户端超时重试时带同一个 key，不会重复提交上游扣积分
            const idempotencyKey = request.body.idempotency_key || request.headers['idempotency-key'];

            // 处理文件上传
            const filePaths = [...file_paths];
            const files: Record<string, any> = request.files || {};
            if (!_.isEmpty(files)) {
                Object.values(files).forEach(file => appendUploadedPaths(file, filePaths));
            }

            const { task, done } = startVideoTask({
                authorization: request.headers.authorization,
                ownerHash: db.taskOwnerHash(request.headers.authorization),
                idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
                model,
                prompt,
                ratio,
                resolution,
                duration,
                filePaths,
                allowDowngrade,
                baseOrigin: requestBaseOrigin(request),
            });

            if (asyncMode) return publicVideoTask(getVideoTask(task.id) || task);

            const { videoUrl } = await done;

            if (response_format === "b64_json") {
                const localPath = localVideoPathFromUrl(videoUrl);
                const videoBase64 = localPath
                    ? (await fs.readFile(localPath)).toString('base64')
                    : await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    task_id: task.id,
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            }
            return {
                created: util.unixTimestamp(),
                task_id: task.id,
                data: [{
                    url: videoUrl,
                    revised_prompt: prompt
                }]
            };
        }

    }

}
