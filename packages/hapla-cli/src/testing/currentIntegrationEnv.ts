import type { IntegrationEnvironment } from './integrationEnvironment';

declare global {
    // eslint-disable-next-line no-var
    var __haplaIntegrationEnv: IntegrationEnvironment | undefined;
}

export function getIntegrationEnv(): IntegrationEnvironment {
    if (!globalThis.__haplaIntegrationEnv) {
        throw new Error('No active integration environment');
    }

    return globalThis.__haplaIntegrationEnv;
}
