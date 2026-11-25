export type ReviewLine = {
    kind: 'file' | 'hunk' | 'add' | 'remove' | 'context' | 'meta';
    text: string;
    oldLine?: number;
    newLine?: number;
};
export type ReviewPatch = { lines: ReviewLine[]; added: number; removed: number; files: number; width: number };

/** Tolerates partial pages: the next page is concatenated before parsing again. */
export function parseReviewPatch(patch: string): ReviewPatch {
    const result: ReviewPatch = { lines: [], added: 0, removed: 0, files: 0, width: 0 };
    let oldLine = 0; let newLine = 0; let inHunk = false; let fileHeader: ReviewLine | undefined;
    const raw = patch.split('\n');
    if (raw.at(-1) === '') raw.pop();
    for (const text of raw) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        let line: ReviewLine;
        if (text.startsWith('diff --git ')) {
            inHunk = false; result.files++;
            // Git normally emits an unquoted b/ path; preserve its complete spelling, including spaces.
            const boundary = text.lastIndexOf(' b/');
            const samePath = /^diff --git a\/(.*?) b\/\1$/.exec(text);
            line = { kind: 'file', text: samePath?.[1] ?? (boundary >= 0 ? text.slice(boundary + 3) : text.slice(11)) };
            fileHeader = line;
        } else if (hunk) {
            oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
            line = { kind: 'hunk', text };
        } else if (inHunk && text.startsWith('+')) {
            result.added++; line = { kind: 'add', text: text.slice(1), newLine: newLine++ };
        } else if (inHunk && text.startsWith('-')) {
            result.removed++; line = { kind: 'remove', text: text.slice(1), oldLine: oldLine++ };
        } else if (inHunk && text.startsWith(' ')) {
            line = { kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ };
        } else if (/^(index |--- |\+\+\+ )/.test(text)) {
            if (fileHeader && (text.startsWith('--- a/') || text.startsWith('+++ b/'))) fileHeader.text = text.slice(6);
            continue;
        } else {
            line = { kind: 'meta', text };
        }
        result.lines.push(line);
        // Reserve two monospace cells for wide characters, and four for a tab.
        result.width = Math.max(result.width, Array.from(line.text).reduce((n, char) => n + (char === '\t' ? 4 : char.codePointAt(0)! > 255 ? 2 : 1), 0));
    }
    return result;
}
