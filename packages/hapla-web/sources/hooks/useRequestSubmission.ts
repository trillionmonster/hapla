import * as React from 'react';
import { sessionResources } from '@/sync/sessionResources';

type RequestStatus = 'pending' | 'submitting' | 'approved' | 'denied' | 'canceled' | 'expired';

/** A successful reply RPC only enters waiting; the authoritative request record resolves the card. */
export function useRequestSubmission(sessionId: string | undefined, requestId: string | undefined, status: RequestStatus | undefined) {
    const [phase, setPhase] = React.useState<'idle' | 'sending' | 'waiting'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const busy = React.useRef(false);
    const generation = React.useRef(0);
    const previousStatus = React.useRef(status);
    const currentStatus = React.useRef(status); currentStatus.current = status;
    React.useEffect(() => {
        generation.current++;
        busy.current = false; setPhase('idle'); setError(null);
        return () => { generation.current++; };
    }, [sessionId, requestId]);
    React.useEffect(() => {
        if (status === 'submitting') { busy.current = true; setPhase('waiting'); }
        else if ((status && status !== 'pending') || previousStatus.current === 'submitting') {
            busy.current = false; setPhase('idle');
        }
        previousStatus.current = status;
    }, [status]);
    const submit = React.useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
        if (!sessionId || !requestId || busy.current || (status !== undefined && status !== 'pending')) return false;
        const captured = generation.current;
        const currentResources = sessionResources.capture(sessionId);
        const isCurrent = () => captured === generation.current && currentResources();
        busy.current = true; setPhase('sending'); setError(null);
        try {
            await action();
            if (!isCurrent()) return false;
            if (currentStatus.current && currentStatus.current !== 'pending' && currentStatus.current !== 'submitting') { busy.current = false; setPhase('idle'); }
            else setPhase('waiting');
            return true;
        } catch {
            if (isCurrent()) { busy.current = false; setPhase('idle'); setError('提交失败，请重试'); }
            return false;
        }
    }, [sessionId, requestId, status]);
    return { submit, error, isBusy: phase !== 'idle' || status === 'submitting', phase };
}
