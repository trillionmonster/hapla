import type { Socket } from 'socket.io';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { log } from '@/utils/log';

// Finish authentication and scope ownership checks before Socket.IO emits
// `connection`, joins event rooms, or attaches RPC handlers.
export async function authenticateSocket(socket: Socket, next: (error?: Error) => void): Promise<void> {
    const { token, clientType, sessionId, machineId } = socket.handshake.auth;

    if (typeof token !== 'string' || !token) {
        next(new Error('Missing authentication token'));
        return;
    }
    if (clientType !== undefined && !['user-scoped', 'session-scoped', 'machine-scoped'].includes(clientType)) {
        next(new Error('Invalid client type'));
        return;
    }
    if (clientType === 'session-scoped' && (typeof sessionId !== 'string' || !sessionId.trim())) {
        next(new Error('Session ID required for session-scoped clients'));
        return;
    }
    if (clientType === 'machine-scoped' && (typeof machineId !== 'string' || !machineId.trim())) {
        next(new Error('Machine ID required for machine-scoped clients'));
        return;
    }

    try {
        const verified = await auth.verifyToken(token);
        if (!verified) {
            next(new Error('Invalid authentication token'));
            return;
        }

        if (clientType === 'session-scoped') {
            const session = await db.session.findFirst({
                where: { id: sessionId, accountId: verified.userId },
                select: { id: true },
            });
            if (!session) {
                next(new Error('Session not found'));
                return;
            }
        }
        if (clientType === 'machine-scoped') {
            const machine = await db.machine.findFirst({
                where: { id: machineId, accountId: verified.userId },
                select: { id: true },
            });
            if (!machine) {
                next(new Error('Machine not found'));
                return;
            }
        }

        socket.data.userId = verified.userId;
        socket.data.clientType = clientType;
        socket.data.sessionId = clientType === 'session-scoped' ? sessionId : undefined;
        socket.data.machineId = clientType === 'machine-scoped' ? machineId : undefined;
        socket.data.haplaClient = socket.handshake.auth.haplaClient as string
            || socket.handshake.headers['x-hapla-client'] as string
            || undefined;
        next();
    } catch (error) {
        log({ module: 'websocket', level: 'error' }, `Socket authentication failed: ${error}`);
        next(new Error('Authentication failed'));
    }
}
