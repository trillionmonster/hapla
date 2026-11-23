import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';

vi.mock('@/storage/db', () => ({ db: {} }));

import { getMetricsLabelsFromRequest, getMetricsLabelsFromSocket } from './metrics2';

describe('untrusted client metric labels', () => {
    const unknown = { client: 'unknown', client_type: 'unknown' };

    it.each([undefined, null, '', false, true, 0, 42, [], ['web/1.0'], {}, { surface: 'maintenance' }])(
        'does not crash a Socket.IO connection for %j', raw => {
            expect(getMetricsLabelsFromSocket({ data: { haplaClient: raw } } as unknown as Socket)).toEqual(unknown);
        },
    );

    it('does not coerce arbitrary auth objects to strings', () => {
        const raw = { toString() { throw new Error('Untrusted conversion'); } };
        expect(getMetricsLabelsFromSocket({ data: { haplaClient: raw } } as unknown as Socket)).toEqual(unknown);
    });

    it('handles missing and repeated HTTP client headers', () => {
        expect(getMetricsLabelsFromRequest({ headers: {} })).toEqual(unknown);
        expect(getMetricsLabelsFromRequest({ headers: { 'x-hapla-client': ['web/1.0', 'web/2.0'] } })).toEqual(unknown);
    });

    it.each(['web/1.0', 'CLI-DAEMON/1.1.7', 'desktop'])(
        'preserves valid client labels for %s', raw => {
            const expected = { client: raw, client_type: raw.split('/')[0].toLowerCase() };
            expect(getMetricsLabelsFromSocket({ data: { haplaClient: raw } } as unknown as Socket)).toEqual(expected);
            expect(getMetricsLabelsFromRequest({ headers: { 'x-hapla-client': raw } })).toEqual(expected);
        },
    );
});
