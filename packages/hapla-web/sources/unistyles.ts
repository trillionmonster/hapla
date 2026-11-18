import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { darkTheme, lightTheme } from './theme';
import { loadLocalSettings } from './sync/persistence';
import { createTypographyTheme, type FontSizeLevel } from './constants/typeScale';
import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';

//
// Theme
//

const localSettings = loadLocalSettings();
const typography = createTypographyTheme(localSettings.fontSizeLevel);
const appThemes = {
    light: { ...lightTheme, ...typography },
    dark: { ...darkTheme, ...typography }
};

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
    // use as many breakpoints as you need
};

// Load theme preference from storage
const themePreference = localSettings.themePreference;

// Determine initial theme and adaptive settings
const getInitialTheme = (): 'light' | 'dark' => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
};

const settings = themePreference === 'adaptive'
    ? {
        // When adaptive, let Unistyles handle theme switching automatically
        adaptiveThemes: true,
        CSSVars: true, // Enable CSS variables for web
    }
    : {
        // When fixed theme, set the initial theme explicitly
        initialTheme: getInitialTheme(),
        CSSVars: true, // Enable CSS variables for web
    };

//
// Bootstrap
//

type AppThemes = typeof appThemes
type AppBreakpoints = typeof breakpoints

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
})

export function applyFontSizeLevel(level: FontSizeLevel) {
    const typography = createTypographyTheme(level);
    // Update the active theme first: Unistyles refreshes numeric styles before
    // updating its CSS-variable theme cache, so the second update sees new sizes.
    const themes = UnistylesRuntime.themeName === 'dark' ? ['dark', 'light'] as const : ['light', 'dark'] as const;
    for (const name of themes) {
        UnistylesRuntime.updateTheme(name, theme => ({ ...theme, ...typography }));
    }
}

// Set initial root view background color based on theme
const setRootBackgroundColor = () => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        const color = systemTheme === 'dark' ? appThemes.dark.colors.groupped.background : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        SystemUI.setBackgroundColorAsync(color);
    } else {
        const color = themePreference === 'dark' ? appThemes.dark.colors.groupped.background : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        SystemUI.setBackgroundColorAsync(color);
    }
};

// Set initial background color
setRootBackgroundColor();
