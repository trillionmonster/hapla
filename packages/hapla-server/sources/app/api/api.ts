import fastify from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { kvRoutes } from "./routes/kvRoutes";
import { uploadsRoutes } from "./routes/uploadsRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { sessionProtocolRoutes } from './routes/sessionProtocolRoutes';
import { privateFilesRoutes } from './routes/privateFilesRoutes';
import { externalVideoPreviewRoutes } from './routes/externalVideoPreviewRoutes';
import { cloudFileRoutes } from './routes/cloudFileRoutes';
import { directFileRoutes } from './routes/directFileRoutes';
import { MediaAccess } from '@/app/auth/mediaAccess';
import { enableSiteAccess } from './routes/siteAccessRoutes';
import { SiteAccess } from '@/app/auth/siteAccess';
import { auth } from '@/app/auth/auth';

export async function startApi() {

    // Configure
    log('Starting API...');

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });
    enableSiteAccess(app, SiteAccess.fromEnvironment(), token => auth.verifyToken(token));
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'HEAD', 'POST', 'DELETE']
    });
    app.get('/', function (request, reply) {
        reply.send('Welcome to Hapla Server!');
    });

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed);
    enableAuthentication(typed);

    privateFilesRoutes(typed, new MediaAccess(process.env.HAPLA_MASTER_SECRET!));
    externalVideoPreviewRoutes(typed);
    cloudFileRoutes(typed);
    directFileRoutes(typed);

    // Routes
    authRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    kvRoutes(typed);
    uploadsRoutes(typed);
    v3SessionRoutes(typed);
    sessionProtocolRoutes(typed);

    // Start HTTP 
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: '0.0.0.0' });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log('API ready on port http://localhost:' + port);
}
