import Request from '@/lib/request/Request.ts';
import { resolveAuthorization } from '@/api/controllers/auth.ts';
import { listModelConfigs, toOpenAIModel } from '@/api/controllers/models.ts';

export default {

    prefix: '/v1',

    get: {
        '/models': async (request: Request) => {
            let jimengToken: string | undefined;
            if (typeof request.headers.authorization === 'string') {
                try {
                    const credential = await resolveAuthorization(request.headers.authorization, 'jimeng');
                    jimengToken = credential.token;
                } catch (err: any) {
                    if (String(err?.message).includes('API key')) throw err;
                    // 当账号池仅配置豆包账号而无即梦账号时，直接返回静态模型清单（含豆包与即梦）
                }
            }
            const refresh = request.query.refresh === 'true' || request.query.refresh === '1';
            const type = request.query.type === 'image' || request.query.type === 'video'
                ? request.query.type
                : undefined;
            const models = await listModelConfigs(jimengToken, { refresh, type });

            return {
                data: models.map(toOpenAIModel)
            };
        }

    }
}
