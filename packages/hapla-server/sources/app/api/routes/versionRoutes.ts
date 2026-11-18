import { z } from "zod";
import { type Fastify } from "../types";

export function versionRoutes(app: Fastify) {
    app.post('/v1/version', {
        schema: {
            body: z.object({
                platform: z.string(),
                version: z.string(),
                app_id: z.string()
            }),
            response: {
                200: z.object({
                    updateUrl: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        // Hapla is web-first. Keep the compatibility endpoint for older clients,
        // but never redirect them to the removed upstream native applications.
        reply.send({ updateUrl: null });
    });
}
