import { describe, expect, it } from 'vitest';
import { applyLocalSettings, localSettingsParse } from './localSettings';
import { createTypographyTheme, fontSizeLevels, typeScale } from '@/constants/typeScale';

describe('font size preference', () => {
    it('keeps the current reading size for existing installations', () => {
        const settings = localSettingsParse({ themePreference: 'dark', debugMode: true });
        expect(settings.fontSizeLevel).toBe(3);
        expect(settings.themePreference).toBe('dark');
        expect(createTypographyTheme(settings.fontSizeLevel).typography).toEqual(typeScale);
    });

    it.each(fontSizeLevels)('retains level %i through serialization', level => {
        const settings = applyLocalSettings(localSettingsParse({}), { fontSizeLevel: level });
        expect(localSettingsParse(JSON.parse(JSON.stringify(settings))).fontSizeLevel).toBe(level);
    });

    it.each([0, 6, 2.5, 'large', null])('recovers an invalid font size %s without losing other preferences', fontSizeLevel => {
        const settings = localSettingsParse({ fontSizeLevel, themePreference: 'dark', debugMode: true });
        expect(settings.fontSizeLevel).toBe(3);
        expect(settings.themePreference).toBe('dark');
        expect(settings.debugMode).toBe(true);
    });

    it('offers five distinct reading sizes and scales UI and code with their line spacing', () => {
        const scales = fontSizeLevels.map(createTypographyTheme);
        expect(scales.map(scale => scale.typography.body.fontSize)).toEqual([14, 16, 18, 20, 22]);
        for (const role of Object.keys(typeScale) as Array<keyof typeof typeScale>) {
            const sizes = scales.map(scale => scale.typography[role]);
            expect(new Set(sizes.map(size => size.fontSize)).size).toBe(5);
            expect(sizes.every(size => size.lineHeight >= size.fontSize * 1.2)).toBe(true);
            expect(sizes.every((size, i) => i === 0 || size.lineHeight > sizes[i - 1].lineHeight)).toBe(true);
        }
        for (const scale of scales) {
            expect(scale.fonts.bodyFontSize).toBe(`${scale.typography.body.fontSize}px`);
            expect(scale.fonts.bodyLineHeight).toBe(`${scale.typography.body.lineHeight}px`);
        }
    });
});
