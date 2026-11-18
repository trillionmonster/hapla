import { isLocalNetworkHostname } from '@hapla/wire';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';

let verified: { origin: string; until: number } | undefined;
export async function usesDirectFileDelivery(): Promise<boolean> {
    if (typeof window === 'undefined' || !window.location?.hostname || !isLocalNetworkHostname(window.location.hostname)) return false;
    const origin = new URL(getServerUrl()).origin;
    if (!isLocalNetworkHostname(new URL(origin).hostname)) return false;
    if (verified?.origin === origin && verified.until > Date.now()) return true;
    const response = await apiSocket.request('/v1/files/delivery-mode', { cache: 'no-store' });
    if (!response.ok || (await response.json()).direct !== true) throw new Error('局域网文件服务尚未就绪，请重试');
    verified = { origin, until: Date.now() + 30_000 }; return true;
}
