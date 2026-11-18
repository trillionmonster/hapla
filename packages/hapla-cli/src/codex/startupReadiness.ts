/** A daemon must not route a prompt to a worker whose provider failed to start. */
export async function runCodexStartup(options: {
    initialize: () => Promise<void>;
    acknowledge: () => Promise<void>;
    reportFailure: (error: Error) => void;
}): Promise<void> {
    try {
        await options.initialize();
        await options.acknowledge();
    } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        try { options.reportFailure(error); } finally { throw error; }
    }
}
