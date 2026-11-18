/** An authoritative failed turn, rather than an unconfirmed transport failure. */
export class CodexTurnFailure extends Error {
    recovery: 'notAttempted' | 'restored' | 'failed' = 'notAttempted';
    recoveryError?: string;

    constructor(
        readonly threadId: string,
        readonly turnId: string,
        readonly processEpoch: number,
        readonly providerError: unknown,
    ) {
        const message = providerError && typeof providerError === 'object'
            && 'message' in providerError && typeof providerError.message === 'string'
            ? providerError.message : typeof providerError === 'string' ? providerError : 'Codex turn failed';
        super(message);
        this.name = 'CodexTurnFailure';
    }

    get isServerError(): boolean {
        const error = this.providerError && typeof this.providerError === 'object'
            ? this.providerError as Record<string, unknown> : {};
        const info = error.codexErrorInfo;
        if (typeof info === 'string' && info !== 'other') {
            return info === 'internalServerError' || info === 'serverOverloaded';
        }
        if (info && typeof info === 'object') {
            for (const detail of Object.values(info)) {
                const status = detail && typeof detail === 'object' && 'httpStatusCode' in detail
                    ? detail.httpStatusCode : null;
                if (typeof status === 'number' && status >= 500 && status <= 599) return true;
                if (typeof status === 'number' && status >= 400 && status <= 499) return false;
            }
        }
        // Older CLI versions expose an HTTP-200 SSE server_error as "other".
        return error.code === 'server_error' || /\bserver_error\b|an error occurred while processing your request/i.test(this.message);
    }
}
