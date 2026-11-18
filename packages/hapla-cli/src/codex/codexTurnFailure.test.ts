import { describe, expect, it } from 'vitest';
import { CodexTurnFailure } from './codexTurnFailure';

describe('CodexTurnFailure server error classification', () => {
    it.each([
        { codexErrorInfo: 'other', message: 'stream disconnected before completion: An error occurred while processing your request. Request ID req-original' },
        { codexErrorInfo: 'internalServerError', message: 'Internal error' },
        { codexErrorInfo: 'serverOverloaded', message: 'Busy' },
        { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } }, message: 'Retries exhausted' },
        { code: 'server_error', message: 'Failed' },
    ])('recognizes a provider server error: %j', (error) => {
        const failure = new CodexTurnFailure('thread', 'turn', 1, error);
        expect(failure.isServerError).toBe(true);
        expect(failure.message).toBe(error.message);
        expect(failure.providerError).toBe(error);
    });

    it.each([
        { codexErrorInfo: 'unauthorized', message: 'server_error' },
        { codexErrorInfo: 'usageLimitExceeded', message: 'Limit exceeded' },
        { codexErrorInfo: 'rateLimitExceeded', message: 'Too many requests' },
        { codexErrorInfo: 'contextWindowExceeded', message: 'Context too long' },
        { codexErrorInfo: 'badRequest', message: 'Invalid argument' },
        { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, message: 'server_error' },
        { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, message: 'Connection lost' },
        { message: 'Command exited with code 1' },
        null,
    ])('does not treat unrelated failures as a server error: %j', (error) => {
        expect(new CodexTurnFailure('thread', 'turn', 1, error).isServerError).toBe(false);
    });
});
