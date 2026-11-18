import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createTypeScale, fontSizeLevels, type FontSizeLevel } from '@/constants/typeScale';
import { Typography } from '@/constants/Typography';
import { useLocalSettingMutable } from '@/sync/storage';
import { applyFontSizeLevel } from '@/unistyles';
import { t } from '@/text';

export function FontSizeSettings() {
    const { theme } = useUnistyles();
    const [level, setLevel] = useLocalSettingMutable('fontSizeLevel');
    const labels = {
        1: t('settingsAppearance.fontSizeOptions.small'),
        2: t('settingsAppearance.fontSizeOptions.smaller'),
        3: t('settingsAppearance.fontSizeOptions.standard'),
        4: t('settingsAppearance.fontSizeOptions.larger'),
        5: t('settingsAppearance.fontSizeOptions.large'),
    } satisfies Record<FontSizeLevel, string>;
    const select = (size: FontSizeLevel) => {
        setLevel(size);
        applyFontSizeLevel(size);
    };

    return (
        <View style={styles.container}>
            <View style={styles.heading}>
                <Text style={styles.title}>{t('settingsAppearance.fontSize')}</Text>
                <Text style={styles.value}>{labels[level]} · {theme.typography.body.fontSize} px</Text>
            </View>
            <View accessibilityRole="radiogroup" accessibilityLabel={t('settingsAppearance.fontSize')} style={styles.choices}>
                {fontSizeLevels.map(size => {
                    const fontSize = createTypeScale(size).body.fontSize;
                    const selected = size === level;
                    return (
                        <Pressable
                            key={size}
                            accessibilityRole="radio"
                            accessibilityLabel={`${labels[size]} · ${fontSize} px`}
                            accessibilityState={{ checked: selected }}
                            aria-checked={selected}
                            onPress={() => select(size)}
                            {...(Platform.OS === 'web' ? {
                                tabIndex: selected ? 0 : -1,
                                onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                                    const key = event.key;
                                    if (![' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
                                    event.preventDefault();
                                    const next = key === 'Home' ? 1 : key === 'End' ? 5 : key === ' ' ? size
                                        : ((size - 1 + (key === 'ArrowLeft' || key === 'ArrowUp' ? 4 : 1)) % 5 + 1) as FontSizeLevel;
                                    select(next);
                                    event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next - 1]?.focus();
                                },
                            } : {})}
                            style={({ pressed }) => [styles.choice, selected && styles.selected, pressed && { opacity: 0.8 }]}
                        >
                            <Text style={[styles.letter, { fontSize }, selected && styles.selectedText]}>Aa</Text>
                            <Text style={[styles.number, selected && styles.selectedText]}>{fontSize}</Text>
                        </Pressable>
                    );
                })}
            </View>
            <View style={styles.preview}>
                <Text style={styles.previewText}>{t('settingsAppearance.fontSizePreview')}</Text>
                <Text style={styles.previewCode}>const size = {theme.typography.body.fontSize};</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    container: { padding: 16, gap: 16 },
    heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    title: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight },
    value: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight },
    choices: { flexDirection: 'row', gap: 6 },
    choice: { flex: 1, minWidth: 0, minHeight: 76, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10 },
    selected: { borderColor: theme.colors.textLink, backgroundColor: theme.colors.surfaceHigh },
    selectedText: { color: theme.colors.textLink },
    letter: { ...Typography.default('semiBold'), color: theme.colors.text },
    number: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight },
    preview: { padding: 14, gap: 8, backgroundColor: theme.colors.surfaceHigh, borderRadius: 8 },
    previewText: { ...Typography.default(), color: theme.colors.text, fontSize: theme.typography.body.fontSize, lineHeight: theme.typography.body.lineHeight },
    previewCode: { ...Typography.mono(), color: theme.colors.textSecondary, fontSize: theme.typography.code.fontSize, lineHeight: theme.typography.code.lineHeight },
}));
