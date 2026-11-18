import { log } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError, type FastifyRequest } from "fastify";
import { CloudDeliveryError } from '@/storage/cloudFileDelivery';

function isAccessLogin(request: FastifyRequest): boolean {
    // Both bodies contain credentials: access passwords or signed object URLs.
    const paths = ['/access/login', '/v1/media/video-preview', '/v1/files/direct/resolve', '/v1/files/cloud/resolve'];
    return paths.includes(request.routeOptions.url ?? '') || paths.includes(request.url.split('?')[0]);
}

export function enableErrorHandlers(app: Fastify) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
        // Only this typed adapter error contains messages we chose locally.
        // Preserve actionable media failures without exposing arbitrary 5xx
        // exception text, NAS responses, signed URLs, or request bodies.
        if (error instanceof CloudDeliveryError) {
            return reply.header('Cache-Control', 'no-store').code(error.statusCode)
                .send({ error: 'file_delivery_failed', message: error.message, statusCode: error.statusCode });
        }
        // JSON parser errors can embed part of the input. Never include a
        // submitted access password in logs or an error response.
        if (isAccessLogin(request)) {
            return reply.header('Cache-Control', 'no-store').code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
                .send({ error: '无法验证请求，请重试。' });
        }
        const method = request.method;
        const url = request.url;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        // Log the error with comprehensive context
        log({
            module: 'fastify-error',
            level: 'error',
            method,
            url,
            userAgent,
            ip,
            statusCode: error.statusCode || 500,
            errorCode: error.code,
            stack: error.stack
        }, `Unhandled error: ${error.message}`);

        // Return appropriate error response
        const statusCode = error.statusCode || 500;

        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Never log request headers here: they may contain bearer tokens, cookies,
    // or reverse-proxy credentials. Method/path/client metadata is sufficient
    // to diagnose an unknown route.
    app.setNotFoundHandler((request, reply) => {
        log({
            module: '404-handler',
            method: request.method,
            path: request.url,
            userAgent: request.headers['user-agent'] || 'unknown',
            ip: request.ip || 'unknown',
        }, 'Route not found');
        reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
    });

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        if (error instanceof CloudDeliveryError) {
            log({ module: 'file-delivery-error', level: 'warn', method: request.method,
                statusCode: error.statusCode }, error.message);
            return;
        }
        if (isAccessLogin(request)) {
            log({ module: 'site-access-error', level: 'error', method: request.method,
                statusCode: error.statusCode || 500, errorCode: error.code }, 'Site access request failed');
            return;
        }
        const method = request.method;
        const url = request.url;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || error.statusCode || 500,
            errorName: error.name,
            errorCode: error.code
        }, `Request error: ${error.message}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        if (isAccessLogin(request)) return;
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: request.url,
                    stack: error.stack
                }, `Response serialization error: ${error.message}`);
                throw error;
            }
        };
    });
}
