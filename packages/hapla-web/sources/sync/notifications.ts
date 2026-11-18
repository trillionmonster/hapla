export const SchedulableTriggerInputTypes = { TIME_INTERVAL: 'timeInterval' } as const;

export async function scheduleNotificationAsync(_request: unknown): Promise<string> {
    return '';
}

export async function cancelScheduledNotificationAsync(_id: string): Promise<void> {}
