import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { log } from "@/utils/log";
import { getMetricsLabelsFromSocket, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { db } from "@/storage/db";
import { authenticateSocket } from "./socket/authenticateSocket";
import { startAsrNamespace } from './socket/asrHandler';

import { previewBroker } from '@/app/preview/previewBroker';

export function startSocket(app: Fastify) {
    const io = new Server(app.server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            credentials: true,
            allowedHeaders: ["*"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        destroyUpgrade: false,
        serveClient: false, // Don't serve the client files
    });

    startAsrNamespace(io);
    previewBroker.start(io);

    // Initialize event router with Socket.IO server instance
    eventRouter.init(io);

    // Auth runs in middleware so it completes BEFORE the client's `connect`
    // event fires. Without this, the async verifyToken in the connection
    // callback creates a window where client events (rpc-register, rpc-call)
    // arrive before handlers are attached — and get silently dropped.
    io.use(authenticateSocket);

    io.on("connection", (socket) => {
        const userId = socket.data.userId as string;
        const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.data.sessionId as string | undefined;
        const machineId = socket.data.machineId as string | undefined;
        const labels = getMetricsLabelsFromSocket(socket);

        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, client: ${labels.client}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId
            };
        }
        eventRouter.addConnection(userId, connection);
        websocketConnectionsGauge.inc({ type: connection.connectionType, ...labels });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        socket.on('disconnect', async () => {
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });

            log({ module: 'websocket' }, `User disconnected: ${userId}`);

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const remainingMachineSockets = await io.in(`user:${userId}:machine:${connection.machineId}`).fetchSockets();
                if (remainingMachineSockets.length > 0) return;
                const disconnectedAt = Date.now();
                await db.machine.updateMany({
                    where: { id: connection.machineId, accountId: userId },
                    data: { active: false, lastActiveAt: new Date(disconnectedAt) },
                }).catch((error) => {
                    log({ module: 'websocket', level: 'error' }, `Failed to persist machine disconnect: ${error}`);
                });
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, disconnectedAt);
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        });

        // Handlers
        rpcHandler(userId, socket, io);
        usageHandler(userId, socket);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket);

        // Ready
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    onShutdown('api', async () => {
        await io.close();
    });
}
