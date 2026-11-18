import axios, { type AxiosResponse } from 'axios';

const ACCESS_COOKIE = 'hapla_site_access';
type AuthPath = '/v1/auth' | '/v1/auth/request';

export class SiteAccessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SiteAccessError';
    }
}

async function readAccessPassword(): Promise<string> {
    const configured = process.env.HAPLA_ACCESS_PASSWORD;
    if (configured) return configured;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new SiteAccessError('This server requires a global access password. Set HAPLA_ACCESS_PASSWORD for this login command, or run it in an interactive terminal.');
    }
    try {
        const { default: inquirer } = await import('inquirer');
        const answer = await inquirer.prompt<{ password: string }>([{
            type: 'password',
            name: 'password',
            message: 'Global Hapla access password:',
            mask: '*',
        }]);
        if (answer.password) return answer.password;
    } catch {
        throw new SiteAccessError('Global access password entry cancelled.');
    }
    throw new SiteAccessError('A global access password is required.');
}

function accessRequired(error: unknown): boolean {
    return axios.isAxiosError(error)
        && error.response?.status === 401
        && error.response.data?.code === 'SITE_ACCESS_REQUIRED';
}

function requestError(error: unknown): Error {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    // Axios errors retain request headers and bodies. Never propagate them to
    // CLI debug logging after a cookie or access password has been attached.
    return new Error(status ? `Authentication request failed (HTTP ${status}).` : 'Authentication request failed. Check the server address and connection.');
}

/** An auth-flow-local cookie; existing bearer-authenticated clients are unchanged. */
export function createAuthClient(serverUrl: string, cliVersion: string) {
    const base = new URL(serverUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
        throw new Error('HAPLA_SERVER_URL must be an HTTP(S) URL without embedded credentials.');
    }
    const client = axios.create({
        baseURL: serverUrl.replace(/\/$/, ''),
        timeout: 15_000,
        // Do not forward the password or cookie through a redirect. Configure
        // HAPLA_SERVER_URL with the final server URL instead.
        maxRedirects: 0,
        headers: { 'X-Hapla-Client': `cli/${cliVersion}` },
    });
    let cookie: string | undefined;

    async function unlock(): Promise<void> {
        const password = await readAccessPassword();
        let response: AxiosResponse;
        try {
            response = await client.post('/access/login', { password }, {
                headers: { Origin: base.origin, 'Content-Type': 'application/json' },
            });
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (status === 401) throw new SiteAccessError('Global access password is incorrect. Check HAPLA_ACCESS_PASSWORD or retry in an interactive terminal.');
            if (status === 429) throw new SiteAccessError('Too many global access password attempts. Wait one minute before retrying.');
            if (status && status >= 300 && status < 400) throw new SiteAccessError('Global access login was redirected. Set HAPLA_SERVER_URL to the final server URL.');
            throw new SiteAccessError('Could not verify the global access password. Check the server address and connection.');
        }
        cookie = response.headers['set-cookie']?.map(value => value.split(';', 1)[0].trim())
            .find(value => new RegExp(`^${ACCESS_COOKIE}=[A-Za-z0-9._-]{1,256}$`).test(value));
        if (!cookie) throw new SiteAccessError('Global access login did not return an access cookie. Check the server or proxy configuration.');
    }

    return {
        async post<T = any>(path: AuthPath, data: unknown): Promise<AxiosResponse<T>> {
            // Keep the cookie confined to the authentication endpoints even if
            // a JavaScript caller bypasses the TypeScript path restriction.
            if (path !== '/v1/auth' && path !== '/v1/auth/request') throw new Error('Unsupported authentication endpoint.');
            const send = () => client.post<T>(path, data, { headers: cookie ? { Cookie: cookie } : {} });
            try {
                return await send();
            } catch (error) {
                if (!accessRequired(error)) throw requestError(error);
            }
            await unlock();
            try {
                return await send();
            } catch (error) {
                if (accessRequired(error)) throw new SiteAccessError('The server rejected the access cookie. Check the server or proxy configuration.');
                throw requestError(error);
            }
        },
    };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
