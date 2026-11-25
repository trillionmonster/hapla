const isGitHandlerMissing = (error: unknown) => /^(RPC method not available|Method not found)$/i.test(error instanceof Error ? error.message : String(error));

export function gitWorkbenchErrorCode(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isGitHandlerMissing(error)) return 'unsupported';
    if (/not a git repository/i.test(message)) return 'notRepository';
    if (/timeout|timed out/i.test(message)) return 'timedOut';
    if (/disconnected|not connected|Workspace is unavailable|(?:Machine|Session) encryption not found/i.test(message)) return 'unavailable';
    return 'failed';
}

