import type { MarkdownBlock, MarkdownSpan } from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";
import { isMediaReference } from '../media/mediaKind';
import { unwrapMarkdownLinkTarget } from './linkUtils';

function standaloneMediaLink(value: string): { alt: string; url: string } | null {
    const match = value.match(/^\[([^\]]*)\]\((.+)\)$/);
    if (!match) return null;
    const url = unwrapMarkdownLinkTarget(match[2]);
    return isMediaReference(url) ? { alt: match[1], url } : null;
}

// Split a pipe-delimited table row into cells, stripping only the leading/trailing
// empty strings caused by outer pipes while preserving interior empty cells.
function splitTableRow(line: string): string[] {
    const cells: string[] = [];
    let cell = '';
    let escaped = false;
    for (const character of line.trim()) {
        if (escaped) {
            cell += character === '|' ? '|' : `\\${character}`;
            escaped = false;
        } else if (character === '\\') {
            escaped = true;
        } else if (character === '|') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += character;
        }
    }
    if (escaped) cell += '\\';
    cells.push(cell.trim());
    let normalized = cells;
    if (normalized.length > 0 && normalized[0] === '') normalized = normalized.slice(1);
    if (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized = normalized.slice(0, -1);
    return normalized;
}

function beginsBlock(lines: string[], index: number): boolean {
    const value = lines[index]?.trim() ?? '';
    if (!value) return true;
    if (/^(?:#{1,6}\s|>{1,}\s?|`{3,}|~{3,}|\$\$|<options>|[-*+]\s+|\d+\.\s+)/.test(value)) return true;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(value.replace(/\s+/g, ''))) return true;
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(value) || standaloneMediaLink(value) || isMediaReference(value)) return true;
    if (value.includes('|') && lines[index + 1]?.includes('-')) return true;
    return false;
}

function parseTable(lines: string[], startIndex: number): { table: MarkdownBlock | null; nextIndex: number } {
    let index = startIndex;
    const tableLines: string[] = [];

    // Collect consecutive lines that contain pipe characters, skipping blank lines
    // that LLMs often insert between table rows
    while (index < lines.length) {
        if (lines[index].includes('|')) {
            tableLines.push(lines[index]);
            index++;
        } else if (lines[index].trim() === '') {
            index++;
        } else {
            break;
        }
    }

    if (tableLines.length < 2) {
        return { table: null, nextIndex: startIndex };
    }

    // Validate that the second line is a separator containing dashes, which distinguishes tables from plain text
    const separatorLine = tableLines[1].trim();
    const isSeparator = /^[|\s\-:=]*$/.test(separatorLine) && separatorLine.includes('-');

    if (!isSeparator) {
        return { table: null, nextIndex: startIndex };
    }

    const headers = splitTableRow(tableLines[0])
        .map(cell => parseMarkdownSpans(cell, false));

    if (headers.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    // Extract data rows from remaining lines (skipping the separator line)
    const rows: MarkdownSpan[][][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowCells = splitTableRow(tableLines[i])
            .map(cell => parseMarkdownSpans(cell, false));
        if (rowCells.length > 0) {
            rows.push(rowCells);
        }
    }

    const table: MarkdownBlock = {
        type: 'table',
        headers,
        rows
    };

    return { table, nextIndex: index };
}

export function parseMarkdownBlock(markdown: string) {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let index = 0;
    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // Headers
        for (let i = 1; i <= 6; i++) {
            if (line.startsWith(`${'#'.repeat(i)} `)) {
                blocks.push({ type: 'header', level: i as 1 | 2 | 3 | 4 | 5 | 6, content: parseMarkdownSpans(line.slice(i + 1).trim(), true) });
                continue outer;
            }
        }

        // Trim
        let trimmed = line.trim();

        // Display math, either on one line or across a fenced $$ block.
        if (trimmed.startsWith('$$')) {
            const inlineEnd = trimmed.length > 4 && trimmed.endsWith('$$');
            if (inlineEnd) {
                blocks.push({ type: 'math', content: trimmed.slice(2, -2).trim() });
                continue;
            }
            const content: string[] = [trimmed.slice(2)];
            while (index < lines.length) {
                const nextLine = lines[index++];
                if (nextLine.trim().endsWith('$$')) {
                    content.push(nextLine.replace(/\$\$\s*$/, ''));
                    break;
                }
                content.push(nextLine);
            }
            blocks.push({ type: 'math', content: content.join('\n').trim() });
            continue;
        }

        // Fenced code block (CommonMark backtick and tilde forms)
        const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
        if (fenceMatch) {
            const fence = fenceMatch[1][0];
            const minimumLength = fenceMatch[1].length;
            const language = fenceMatch[2].trim() || null;
            let content = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (new RegExp(`^${fence}{${minimumLength},}\\s*$`).test(nextLine.trim())) {
                    index++;
                    break;
                }
                content.push(nextLine);
                index++;
            }
            const contentString = content.join('\n');

            // Detect mermaid diagram language and route to appropriate block type
            if (language === 'mermaid') {
                blocks.push({ type: 'mermaid', content: contentString });
            } else {
                blocks.push({ type: 'code-block', language, content: contentString });
            }
            continue;
        }

        // Horizontal rule
        if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // Setext headings
        if (trimmed && index < lines.length && /^\s*(?:=+|-+)\s*$/.test(lines[index])) {
            const level = lines[index].trim().startsWith('=') ? 1 : 2;
            index++;
            blocks.push({ type: 'header', level, content: parseMarkdownSpans(trimmed, true) });
            continue;
        }

        if (trimmed.startsWith('>')) {
            const quote: string[] = [trimmed.replace(/^>\s?/, '')];
            while (index < lines.length && lines[index].trim().startsWith('>')) {
                quote.push(lines[index].trim().replace(/^>\s?/, ''));
                index++;
            }
            blocks.push({ type: 'blockquote', content: parseMarkdownSpans(quote.join('\n'), false) });
            continue;
        }

        // Options block
        if (trimmed.startsWith('<options>')) {
            let items: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                // Extract content from <option> tags
                const optionMatch = nextLine.match(/<option>(.*?)<\/option>/);
                if (optionMatch) {
                    items.push(optionMatch[1]);
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
            }
            continue;
        }

        // Image block
        const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (imageMatch) {
            blocks.push({ type: 'image', alt: imageMatch[1], url: unwrapMarkdownLinkTarget(imageMatch[2]) });
            continue;
        }

        // A labelled media link contains Markdown syntax around its address.
        // Keep only the destination; treating the whole line as a filename
        // routes signed external URLs to the workspace file RPC by mistake.
        const mediaLink = standaloneMediaLink(trimmed);
        if (mediaLink) {
            blocks.push({ type: 'image', ...mediaLink });
            continue;
        }

        // Only recognized media addresses get an automatic preview. A URL on
        // its own line can still be a repository or webpage, and stays a link.
        if (isMediaReference(trimmed)) {
            blocks.push({ type: 'image', alt: '', url: trimmed });
            continue;
        }

        // If it is a numbered list
        const numberedListMatch = trimmed.match(/^(\d+)\.\s+/);
        if (numberedListMatch) {
            let allLines = [{ number: parseInt(numberedListMatch[1]), content: trimmed.slice(numberedListMatch[0].length) }];
            while (index < lines.length) {
                const nextLine = lines[index].trim();
                const nextMatch = nextLine.match(/^(\d+)\.\s+/);
                if (!nextMatch) break;
                allLines.push({ number: parseInt(nextMatch[1]), content: nextLine.slice(nextMatch[0].length) });
                index++;
            }
            blocks.push({ type: 'numbered-list', items: allLines.map((l) => ({ number: l.number, spans: parseMarkdownSpans(l.content, false) })) });
            continue;
        }

        // GFM task list
        const taskListMatch = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+/);
        if (taskListMatch) {
            const allLines = [{ checked: taskListMatch[1].toLowerCase() === 'x', content: trimmed.slice(taskListMatch[0].length) }];
            while (index < lines.length) {
                const nextLine = lines[index].trim();
                const nextMatch = nextLine.match(/^[-*+]\s+\[([ xX])\]\s+/);
                if (!nextMatch) break;
                allLines.push({ checked: nextMatch[1].toLowerCase() === 'x', content: nextLine.slice(nextMatch[0].length) });
                index++;
            }
            blocks.push({
                type: 'task-list',
                items: allLines.map((item) => ({ checked: item.checked, spans: parseMarkdownSpans(item.content, false) })),
            });
            continue;
        }

        // If it is a list
        const listMatch = trimmed.match(/^([-*+])\s+/);
        if (listMatch) {
            let allLines = [trimmed.slice(listMatch[0].length)];
            while (index < lines.length) {
                const nextLine = lines[index].trim();
                const nextMatch = nextLine.match(/^([-*+])\s+/);
                if (!nextMatch) {
                    break;
                }
                allLines.push(nextLine.slice(nextMatch[0].length));
                index++;
            }
            blocks.push({ type: 'list', items: allLines.map((l) => parseMarkdownSpans(l, false)) });
            continue;
        }

        // Check for table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // Fallback
        if (trimmed.length > 0) {
            const paragraph = [line.trimStart()];
            while (index < lines.length && !beginsBlock(lines, index)) {
                paragraph.push(lines[index].trimStart());
                index++;
            }
            const joined = paragraph.reduce((result, part, partIndex) => {
                if (partIndex === 0) return part;
                const previous = paragraph[partIndex - 1];
                return `${result}${/ {2}$|\\$/.test(previous) ? '\n' : ' '}${part}`;
            }, '');
            blocks.push({ type: 'text', content: parseMarkdownSpans(joined, false) });
        }
    }
    return blocks;
}
