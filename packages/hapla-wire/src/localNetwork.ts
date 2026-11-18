/** Classify the address used to open Hapla, not the proxy's private hop. */
export function isLocalNetworkHostname(value: string): boolean {
    const host = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.home.arpa')) return true;
    if (host === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    const ip = host.split('.').map(Number);
    if (ip.some(part => part < 0 || part > 255)) return false;
    return ip[0] === 10 || ip[0] === 127 || ip[0] === 192 && ip[1] === 168
        || ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31
        || ip[0] === 169 && ip[1] === 254
        || ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127;
}
