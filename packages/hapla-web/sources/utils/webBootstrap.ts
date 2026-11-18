export const WEB_BOOTSTRAP_OVERLAY_ID = 'hapla-bootstrap-overlay';
export const WEB_BOOTSTRAP_LABEL_ID = 'hapla-bootstrap-label';

type BootstrapDocument = Pick<Document, 'getElementById'>;

export type BootstrapRetry = Readonly<{
    failedAttempt: number;
    nextAttempt: number;
    maxAttempts: number;
    error: unknown;
}>;

type RetryBootstrapTaskOptions = Readonly<{
    maxAttempts: number;
    retryDelaysMs?: readonly number[];
    wait?: (milliseconds: number) => Promise<void>;
    onRetry?: (retry: BootstrapRetry) => void;
}>;

export type BootstrapTaskDeadlineResult<T> =
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'failed'; error: unknown }>
    | Readonly<{ status: 'timed-out' }>;

const waitFor = (milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
});

/**
 * Retry a bootstrap dependency a fixed number of times. The caller decides
 * whether exhausting those attempts is fatal or can fall back safely.
 */
export async function retryBootstrapTask<T>(
    task: (attempt: number) => Promise<T>,
    options: RetryBootstrapTaskOptions,
): Promise<T> {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
        throw new RangeError('maxAttempts must be a positive integer');
    }

    const retryDelaysMs = options.retryDelaysMs ?? [];
    const wait = options.wait ?? waitFor;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        try {
            return await task(attempt);
        } catch (error) {
            if (attempt === options.maxAttempts) throw error;
            options.onRetry?.({
                failedAttempt: attempt,
                nextAttempt: attempt + 1,
                maxAttempts: options.maxAttempts,
                error,
            });
            const delayIndex = Math.min(attempt - 1, Math.max(0, retryDelaysMs.length - 1));
            const delay = retryDelaysMs[delayIndex] ?? 0;
            if (delay > 0) await wait(delay);
        }
    }

    throw new Error('Bootstrap retry loop finished unexpectedly');
}

/**
 * Let an optional dependency finish in the background after its startup
 * deadline. Both success and failure stay observed, so a late rejection never
 * becomes an unhandled promise rejection.
 */
export function settleBootstrapTaskWithin<T>(
    task: Promise<T>,
    timeoutMs: number,
): Promise<BootstrapTaskDeadlineResult<T>> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new RangeError('timeoutMs must be a finite non-negative number');
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: BootstrapTaskDeadlineResult<T>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        const timeout = setTimeout(() => finish({ status: 'timed-out' }), timeoutMs);
        void task.then(
            (value) => finish({ status: 'completed', value }),
            (error) => finish({ status: 'failed', error }),
        );
    });
}

/** Update the static overlay while React is still preparing the application. */
export function setWebBootstrapOverlayLabel(
    value: string,
    candidate?: BootstrapDocument,
): boolean {
    const bootstrapDocument = candidate
        ?? (typeof document === 'undefined' ? null : document);
    const label = bootstrapDocument?.getElementById(WEB_BOOTSTRAP_LABEL_ID);
    if (!label) return false;
    label.textContent = value;
    return true;
}

/**
 * Remove the static Web bootstrap only after React has committed visible UI.
 * The operation is deliberately idempotent for React development effects and
 * for pages produced before the resilient bootstrap existed.
 */
export function dismissWebBootstrapOverlay(candidate?: BootstrapDocument): boolean {
    const bootstrapDocument = candidate
        ?? (typeof document === 'undefined' ? null : document);
    const overlay = bootstrapDocument?.getElementById(WEB_BOOTSTRAP_OVERLAY_ID);
    if (!overlay) return false;
    overlay.remove();
    return true;
}
