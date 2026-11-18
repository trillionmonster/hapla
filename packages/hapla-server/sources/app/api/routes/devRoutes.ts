import { Fastify } from '../types';

// All dev/debug routes permanently disabled — no remote log ingestion
export function devRoutes(_app: Fastify) {
    // noop
}