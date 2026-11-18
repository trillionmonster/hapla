import type { FastifyRequest } from 'fastify';
import { isLocalNetworkHostname } from '@hapla/wire';

export function usesLocalFileDelivery(request: FastifyRequest): boolean {
    try { return isLocalNetworkHostname(new URL(`http://${request.headers.host || ''}`).hostname); }
    catch { return false; }
}
