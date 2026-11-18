/** Shared reading hierarchy. Sizes are logical pixels on native and CSS pixels on Web. */
export const typeScale = {
    caption: { fontSize: 14, lineHeight: 21 },
    small: { fontSize: 15, lineHeight: 23 },
    label: { fontSize: 16, lineHeight: 24 },
    body: { fontSize: 18, lineHeight: 29 },
    subheading: { fontSize: 20, lineHeight: 28 },
    heading: { fontSize: 24, lineHeight: 32 },
    title: { fontSize: 28, lineHeight: 36 },
    display: { fontSize: 32, lineHeight: 40 },
    code: { fontSize: 16, lineHeight: 25 },
} as const;

export const fontSizeLevels = [1, 2, 3, 4, 5] as const;
export type FontSizeLevel = typeof fontSizeLevels[number];
export const defaultFontSizeLevel: FontSizeLevel = 3;
export type TypeScale = { [K in keyof typeof typeScale]: { fontSize: number; lineHeight: number } };

/** Keep the reading hierarchy and line spacing consistent at all five sizes. */
export function createTypeScale(level: FontSizeLevel): TypeScale {
    const factor = (12 + level * 2) / typeScale.body.fontSize;
    return Object.fromEntries(Object.entries(typeScale).map(([role, size]) => [role, {
        fontSize: role === 'caption' ? size.fontSize + level - defaultFontSizeLevel : Math.max(12, Math.round(size.fontSize * factor)),
        lineHeight: Math.round(size.lineHeight * factor),
    }])) as TypeScale;
}

export function createTypographyTheme(level: FontSizeLevel) {
    const typography = createTypeScale(level);
    return {
        typography,
        // Unistyles emits CSS variables for strings, while native styles use numbers.
        fonts: {
            bodyFontSize: `${typography.body.fontSize}px`,
            bodyLineHeight: `${typography.body.lineHeight}px`,
            labelFontSize: `${typography.label.fontSize}px`,
        },
    };
}
