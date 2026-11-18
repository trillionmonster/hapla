export function extractTurnUserText(turn: any): string {
    const values: string[] = [];
    const visit = (value: any) => {
        if (!value || typeof value !== 'object') return;
        if ((value.type === 'userMessage' || value.type === 'text' || value.type === 'inputText') && typeof value.text === 'string') {
            values.push(value.text);
        }
        if (Array.isArray(value)) value.forEach(visit);
        else Object.values(value).forEach(visit);
    };
    visit(turn?.items ?? turn);
    return values.join('\n').trim();
}

export function resolveCodexForkPoint(turns: any[], request: { userOrdinal?: number; userText?: string }): {
    target: any;
    previousTurnId?: string;
} | null {
    const userTurns = turns.filter((turn) => extractTurnUserText(turn).length > 0);
    const ordinal = Number.isInteger(request.userOrdinal) ? request.userOrdinal! : -1;
    let target = ordinal >= 0 ? userTurns[ordinal] : null;
    const requestedText = typeof request.userText === 'string' ? request.userText.trim() : '';
    if (!target && requestedText) {
        target = [...userTurns].reverse().find((turn) => {
            const persistedText = extractTurnUserText(turn);
            return persistedText === requestedText || persistedText.startsWith(`${requestedText}\n`);
        }) ?? null;
    }
    if (!target || typeof target.id !== 'string') return null;
    const targetIndex = turns.findIndex((turn) => turn.id === target.id);
    const previousTurnId = targetIndex > 0 && typeof turns[targetIndex - 1]?.id === 'string'
        ? turns[targetIndex - 1].id
        : undefined;
    return { target, previousTurnId };
}
