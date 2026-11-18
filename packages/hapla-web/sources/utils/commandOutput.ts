/** Render terminal output as text, with no executable ANSI links or controls. */
export function commandOutputPreview(value: unknown, maxChars = 32 * 1024): { text: string; truncated: boolean } {
    if (typeof value !== 'string') return { text: '', truncated: false };
    // Bound work before parsing even for legacy unbounded persisted output.
    const tail = value.slice(-maxChars);
    const text = tail
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[@-_]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    return { text, truncated: value.length > maxChars };
}
