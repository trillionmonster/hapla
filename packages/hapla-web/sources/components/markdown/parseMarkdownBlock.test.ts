import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

describe('parseMarkdownBlock - table parsing', () => {
    const cellText = (cell: Array<{ text: string }>) => cell.map((part) => part.text).join('');
    const tableText = (block: any) => ({
        type: block.type,
        headers: block.headers.map(cellText),
        rows: block.rows.map((row: Array<Array<{ text: string }>>) => row.map(cellText)),
    });

    it('parses a standard table without blank lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(tableText(blocks[0])).toEqual({
            type: 'table',
            headers: ['A', 'B'],
            rows: [['1', '2']],
        });
    });

    it('parses a table with blank lines between rows (LLM output)', () => {
        const md = [
            '| A | B |',
            '',
            '|---|---|',
            '',
            '| 1 | 2 |',
            '',
            '| 3 | 4 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        // Should be recognized as a single table, not 4 separate text blocks
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);
        expect(tableText(tableBlocks[0])).toEqual({
            type: 'table',
            headers: ['A', 'B'],
            rows: [['1', '2'], ['3', '4']],
        });
    });

    it('preserves empty interior cells (e.g. row header column)', () => {
        const md = [
            '| | Header1 | Header2 |',
            '|---|---|---|',
            '| Row1 | a | b |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(tableText(blocks[0])).toEqual({
            type: 'table',
            headers: ['', 'Header1', 'Header2'],
            rows: [['Row1', 'a', 'b']],
        });
    });

    it('keeps escaped pipes inside a GFM table cell', () => {
        const blocks = parseMarkdown('| Value | Note |\n| --- | --- |\n| a \\| b | intact |');
        expect(tableText(blocks[0])).toEqual({
            type: 'table',
            headers: ['Value', 'Note'],
            rows: [['a | b', 'intact']],
        });
    });

    it('handles blank lines and empty first cell combined', () => {
        const md = [
            '### Comparison',
            '',
            '| | Plan A | Plan B |',
            '',
            '|--|----|----|',
            '',
            '| Price | $10/mo | $20/mo |',
            '',
            '| Storage | 5 GB | 50 GB |',
            '',
            '| Support | Email only | 24/7 chat |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);

        const table = tableBlocks[0];
        if (table.type !== 'table') throw new Error('not a table');

        // Empty first cell should be preserved
        expect(table.headers).toHaveLength(3);
        expect(cellText(table.headers[0])).toBe('');

        expect(table.rows).toHaveLength(3);
        expect(cellText(table.rows[0][0])).toBe('Price');
    });

    it('stops table collection at non-blank, non-pipe lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
            '',
            'Some text after the table',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        const textBlocks = blocks.filter(b => b.type === 'text');

        expect(tableBlocks).toHaveLength(1);
        expect(textBlocks).toHaveLength(1);
    });
});

describe('parseMarkdownBlock - media references', () => {
    it.each([
        'https://account.r2.cloudflarestorage.com/video/cat-no-fixed-shape.mp4?X-Amz-Credential=FAKE%2Fscope&X-Amz-Signature=a+b%2Bc&part=1&part=2',
        'https://example.test/clip(1).mp4?token=unchanged',
        './artifacts/movie.mp4?revision=1',
    ])('extracts the exact destination of a labelled media link instead of treating Markdown as a workspace path', url => {
        expect(parseMarkdown(`[点击测试视频直链](${url})`)).toEqual([{ type: 'image', alt: '点击测试视频直链', url }]);
        const blocks = parseMarkdown(`完成测试\n[点击测试视频直链](${url})\n下一步说明`);
        expect(blocks.map(block => block.type)).toEqual(['text', 'image', 'text']);
        expect(blocks[1]).toEqual({ type: 'image', alt: '点击测试视频直链', url });
    });

    it('unwraps angle-delimited destinations without changing the signed query', () => {
        const url = 'https://account.r2.dev/movie.mp4?signature=keep%2Bthis+exactly';
        expect(parseMarkdown(`[视频](<${url}>)`)).toEqual([{ type: 'image', alt: '视频', url }]);
    });

    it.each([
        'https://example.test/demo.mp3',
        './artifacts/movie.mp4',
        '/workspace/images/tall.png',
        'relative-image.webp',
    ])('turns a standalone media reference into a preview block: %s', (reference) => {
        expect(parseMarkdown(reference)).toEqual([{ type: 'image', alt: '', url: reference }]);
    });

    it('does not auto-embed a media URL inside prose', () => {
        expect(parseMarkdown('Open https://example.test/demo.mp3 now')[0]?.type).toBe('text');
    });

    it('preserves both pasted GitHub links and accompanying instructions without media cards', () => {
        const urls = [
            'https://github.com/example/first.project.git',
            'https://github.com/example/second-project',
        ];
        const instruction = '参考这两个 github 项目，形成一个 skill';
        const blocks = parseMarkdown([...urls, '', instruction].join('\n'));
        expect(blocks.every((block) => block.type === 'text')).toBe(true);
        const spans = blocks.flatMap((block) => block.type === 'text' ? block.content : []);
        expect(spans.filter((span) => span.url).map((span) => span.url)).toEqual(urls);
        expect(spans.map((span) => span.text).join('')).toContain(instruction);
    });

    it.each([
        'https://github.com/example/project.git',
        'https://github.com/example/project.name',
        'https://github.com/example/project/blob/main/screenshot.png',
        'https://github.com/example/picture.png',
        'https://example.test/article',
        'https://example.test/download?file=picture.png',
        'https://example.test/article#picture.png',
        'https://service.png',
        'https://example.test/archive.zip',
    ])('keeps repository, page, and non-media file URLs as ordinary links: %s', (reference) => {
        expect(parseMarkdown(reference)).toEqual([{
            type: 'text',
            content: [{ styles: [], text: reference, url: reference }],
        }]);
    });

    it.each([
        'https://cdn.example.test/photo.PNG?token=signed',
        'https://raw.githubusercontent.com/example/project/main/screenshot.png',
        'https://github.com/example/project/releases/download/v1/demo.mp4',
    ])('continues to preview an identifiable direct media address: %s', (reference) => {
        expect(parseMarkdown(reference)).toEqual([{ type: 'image', alt: '', url: reference }]);
    });

    it('preserves explicit Markdown image intent for extensionless URLs', () => {
        expect(parseMarkdown('![预览](https://example.test/image-service?id=123)')).toEqual([
            { type: 'image', alt: '预览', url: 'https://example.test/image-service?id=123' },
        ]);
    });

    it('keeps a labelled repository link clickable', () => {
        expect(parseMarkdown('[项目](https://github.com/example/project.git)')).toEqual([{
            type: 'text',
            content: [{ styles: [], text: '项目', url: 'https://github.com/example/project.git' }],
        }]);
    });
});

describe('parseMarkdownBlock - CommonMark structures', () => {
    it('supports tilde fences, blockquotes and setext headings', () => {
        const blocks = parseMarkdown(['Title', '===', '> quoted', '~~~ts', 'const ok = true', '~~~'].join('\n'));
        expect(blocks.map((block) => block.type)).toEqual(['header', 'blockquote', 'code-block']);
        expect(blocks[2]).toMatchObject({ type: 'code-block', language: 'ts', content: 'const ok = true' });
    });

    it.each(['***', '___', '---'])('supports %s horizontal rules', (rule) => {
        expect(parseMarkdown(rule)).toEqual([{ type: 'horizontal-rule' }]);
    });

    it('joins soft-wrapped lines into one paragraph and retains explicit hard breaks', () => {
        const blocks = parseMarkdown('soft wrapped\nparagraph line\n\nfirst hard  \nsecond line');
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatchObject({ type: 'text' });
        if (blocks[0]?.type !== 'text' || blocks[1]?.type !== 'text') throw new Error('not text');
        expect(blocks[0].content.map((span) => span.text).join('')).toBe('soft wrapped paragraph line');
        expect(blocks[1].content.map((span) => span.text).join('')).toContain('\n');
    });
});

describe('parseMarkdownBlock - GFM and math', () => {
    it('parses task lists and strikethrough spans', () => {
        const blocks = parseMarkdown('- [x] shipped\n- [ ] verify ~~legacy~~');
        expect(blocks[0]).toMatchObject({
            type: 'task-list',
            items: [{ checked: true }, { checked: false }],
        });
        if (blocks[0]?.type !== 'task-list') throw new Error('not a task list');
        expect(blocks[0].items[1].spans.some((span) => span.styles.includes('strikethrough'))).toBe(true);
    });

    it('parses inline and display math', () => {
        const blocks = parseMarkdown('Euler: $e^{i\\pi}+1=0$\n$$\n\\int_0^1 x^2 dx\n$$');
        expect(blocks.map((block) => block.type)).toEqual(['text', 'math']);
        if (blocks[0]?.type !== 'text') throw new Error('not text');
        expect(blocks[0].content.some((span) => span.styles.includes('math'))).toBe(true);
    });
});
