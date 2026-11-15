import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import { generateVideoWithRetry, DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import { generateDoubaoVideo, isDoubaoVideoModel } from '@/api/controllers/doubao-videos.ts';
import { executeWithCredentialFailover } from '@/api/controllers/auth.ts';
import util from '@/lib/util.ts';
import db from '@/lib/database.ts';

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
                .validate('headers.authorization', _.isString);

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio,
                resolution,
                duration,
                file_paths = [],
                response_format = "url"
            } = request.body;

            // 处理文件上传
            const filePaths = [...file_paths];
            const files: Record<string, any> = request.files || {};
            if (!_.isEmpty(files)) {
                Object.values(files).forEach(file => appendUploadedPaths(file, filePaths));
            }

            const useDoubao = isDoubaoVideoModel(model);
            const provider = useDoubao ? 'doubao' : 'jimeng';

            const { result: videoUrl, credential } = await executeWithCredentialFailover(
                request.headers.authorization,
                provider,
                (cred) => useDoubao
                    ? generateDoubaoVideo(model, prompt, { ratio, resolution, duration, filePaths }, cred.token)
                    : generateVideoWithRetry(model, prompt, { ratio, resolution, duration, filePaths }, cred.token)
            );

            const statsKey = credential.managedKey || credential.accountName || credential.token;
            try {
                db.recordCall(statsKey, model, 0);
                if (videoUrl) db.saveMedia('video', videoUrl, model, prompt, statsKey);
            } catch (e) {
                // 忽略数据库错误
            }

            if (response_format === "b64_json") {
                const videoBase64 = await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            }
            return {
                created: util.unixTimestamp(),
                data: [{
                    url: videoUrl,
                    revised_prompt: prompt
                }]
            };
        }

    }

}
