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

export function resolveCodexForkPoint(turns: any[], request: { userOrdinal?: number; userText?: string; turnId?: string }): {
    target: any;
    previousTurnId?: string;
} | null {
    const userTurns = turns.filter((turn) => extractTurnUserText(turn).length > 0);
    const requestedText = typeof request.userText === 'string' ? request.userText.trim() : '';
    let target = request.turnId ? turns.find(turn => turn.id === request.turnId) : null;
    if (!target && requestedText) {
        const matches = userTurns.filter(turn => {
            const text = extractTurnUserText(turn);
            return text === requestedText || text.startsWith(`${requestedText}\n`);
        });
        // Repeated prompts require a durable native turn identity, never a guess.
        if (matches.length === 1) target = matches[0];
    }
    if (!target || typeof target.id !== 'string') return null;
    const targetIndex = turns.findIndex((turn) => turn.id === target.id);
    const previousTurnId = targetIndex > 0 && typeof turns[targetIndex - 1]?.id === 'string'
        ? turns[targetIndex - 1].id
        : undefined;
    return { target, previousTurnId };
}
