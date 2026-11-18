import { describe, expect, it } from 'vitest';
import { isLocalNetworkHostname } from './localNetwork';
describe('local frontend addresses', () => {
    it.each(['localhost', 'LOCALHOST.', 'app.localhost', 'nas.local', 'nas.home.arpa', '192.168.42.10', '127.0.0.1', '192.168.1.2', '172.16.1.1', '172.31.255.254', '169.254.2.3', '100.64.0.1', '100.127.255.254', '[::1]', 'fd42::1', 'fe80::1'])('recognizes %s', host => expect(isLocalNetworkHostname(host)).toBe(true));
    it.each(['203.0.113.10', '172.32.0.1', '172.15.0.1', '192.169.1.1', '100.63.0.1', '100.128.0.1', '10.999.1.1', '10.1.2', '10.0.0.1.evil.test', 'localhost.evil.test', 'example.com', 'app.ngrok.app', '2001:4860::8888', ''])('rejects %s', host => expect(isLocalNetworkHostname(host)).toBe(false));
});
