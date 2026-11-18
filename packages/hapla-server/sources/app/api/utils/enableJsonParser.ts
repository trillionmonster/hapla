import type { Fastify } from '../types';
import { log } from '@/utils/log';

/** Preserve raw webhook bodies without including request secrets in errors. */
export function enableJsonParser(app: Fastify) {
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
        const text = body as string;
        try {
            if (!text || text.trim() === '') {
                (request as any).rawBody = text;
                done(null, request.method === 'DELETE' || request.method === 'GET' ? undefined : {});
                return;
            }
            const parsed = JSON.parse(text);
            (request as any).rawBody = text;
            done(null, parsed);
        } catch {
            // JSON.parse error messages may quote the password/token being
            // parsed. Replace the exception before any Fastify error hooks run.
            log({ module: 'content-parser', level: 'error', method: request.method,
                path: request.url.split('?')[0] }, 'Invalid JSON request');
            const error = Object.assign(new Error('Invalid JSON payload'), {
                statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY',
            });
            done(error, undefined);
        }
    });
}
