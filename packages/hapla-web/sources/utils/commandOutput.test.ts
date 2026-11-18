import { describe, expect, it } from 'vitest';
import { commandOutputPreview } from './commandOutput';

describe('command output preview', () => {
    it('preserves Chinese output while removing ANSI controls and OSC links', () => {
        expect(commandOutputPreview('\x1b[31m失败\x1b[0m\n\x1b]8;;https://evil.test\x07文字\x1b]8;;\x07\0').text).toBe('失败\n文字');
    });
    it('bounds a single huge line before parsing', () => {
        const preview = commandOutputPreview('a'.repeat(11 * 1024 * 1024) + '末尾');
        expect(preview.truncated).toBe(true);
        expect(preview.text.length).toBe(32 * 1024);
        expect(preview.text.endsWith('末尾')).toBe(true);
    });
    it('distinguishes empty output from truncation', () => {
        expect(commandOutputPreview('')).toEqual({ text: '', truncated: false });
    });
});
