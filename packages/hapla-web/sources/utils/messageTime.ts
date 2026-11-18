/** Message timestamps are milliseconds; display the device's local date and time. */
export function formatMessageTime(createdAt: number): string | null {
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime())) return null;
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
