import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import { isDoubaoVideoModel } from '@/api/controllers/doubao-videos.ts';
import { executeWithCredentialFailover, markCredentialFailure, markCredentialSuccess, resolveAuthorization } from '@/api/controllers/auth.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString);

            const { model, messages, stream } = request.body;
            const baseModel = typeof model === 'string' ? model.split(':')[0] : '';
            const provider = isDoubaoVideoModel(baseModel) ? 'doubao' : 'jimeng';

            if (stream) {
                const credential = await resolveAuthorization(request.headers.authorization, provider);
                try {
                    const sseStream = await createCompletionStream(messages, credential.token, model);
                    markCredentialSuccess(credential);
                    return new Response(sseStream, {
                        type: "text/event-stream"
                    });
                } catch (error) {
                    markCredentialFailure(credential);
                    throw error;
                }
            }

            const { result } = await executeWithCredentialFailover(
                request.headers.authorization,
                provider,
                (cred) => createCompletion(messages, cred.token, model)
            );
            return result;
        }

    }

}
