import { afterAll } from 'vitest';
import {
    applyEnvironmentToProcess,
    createIntegrationEnvironment,
    destroyIntegrationEnvironment,
    type EnvironmentTemplate,
    type IntegrationEnvironment,
} from './integrationEnvironment';

type IntegrationEnvironmentProfile = {
    template: EnvironmentTemplate;
    up: boolean;
};

declare global {
    // eslint-disable-next-line no-var
    var __haplaIntegrationEnv: IntegrationEnvironment | undefined;
}

export async function installIntegrationEnvironment(profile: IntegrationEnvironmentProfile) {
    const previousEnv = {
        HAPLA_SERVER_URL: process.env.HAPLA_SERVER_URL,
        HAPLA_WEBAPP_URL: process.env.HAPLA_WEBAPP_URL,
        HAPLA_HOME_DIR: process.env.HAPLA_HOME_DIR,
        HAPLA_PROJECT_DIR: process.env.HAPLA_PROJECT_DIR,
        HAPLA_VARIANT: process.env.HAPLA_VARIANT,
        DEBUG: process.env.DEBUG,
    };

    const env = await createIntegrationEnvironment(profile);
    applyEnvironmentToProcess(env);
    globalThis.__haplaIntegrationEnv = env;

    afterAll(async () => {
        try {
            await destroyIntegrationEnvironment(env);
        } finally {
            for (const [key, value] of Object.entries(previousEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }

            if (globalThis.__haplaIntegrationEnv?.name === env.name) {
                globalThis.__haplaIntegrationEnv = undefined;
            }
        }
    });
}
