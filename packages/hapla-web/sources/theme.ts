import { Platform } from 'react-native';
import { createTypographyTheme, defaultFontSizeLevel } from './constants/typeScale';

// Shared spacing, sizing constants (DRY - used by both themes)
const sharedSpacing = {
    ...createTypographyTheme(defaultFontSizeLevel),
    // Spacing scale (based on actual usage patterns in codebase)
    margins: {
        xs: 4,   // Tight spacing, status indicators
        sm: 8,   // Small gaps, most common gap value
        md: 12,  // Button gaps, card margins
        lg: 16,  // Most common padding value
        xl: 20,  // Large padding
        xxl: 24, // Section spacing
    },

    // Border radii (based on actual usage patterns in codebase)
    borderRadius: {
        sm: 4,   // Checkboxes (20x20 boxes use 4px corners)
        md: 8,   // Buttons, items (most common - 31 uses)
        lg: 10,  // Input fields (matches "new session panel input fields")
        xl: 12,  // Cards, containers (20 uses)
        xxl: 16, // Main containers
    },

    // Icon sizes (based on actual usage patterns)
    iconSize: {
        small: 12,  // Inline icons (checkmark, lock, status indicators)
        medium: 16, // Section headers, add buttons
        large: 20,  // Action buttons (delete, duplicate, edit) - most common
        xlarge: 24, // Main section icons (desktop, folder)
    },
} as const;

export const lightTheme = {
    dark: false,
    colors: {

        //
        // Main colors
        //

        text: '#171717',
        textDestructive: Platform.select({ ios: '#B42318', default: '#B42318' }),
        textSecondary: '#6B6B6B',
        textLink: '#0B795E',
        deleteAction: '#FF6B6B', // Delete/remove button color
        warningCritical: '#FF3B30',
        warning: '#62686E',
        success: '#0B795E',
        surface: '#FFFFFF',
        surfaceRipple: 'rgba(0, 0, 0, 0.08)',
        surfacePressed: '#E8E8E8',
        surfaceSelected: '#E7E7E7',
        surfacePressedOverlay: '#E8E8E8',
        surfaceHigh: '#F7F7F8',
        surfaceHighest: '#ECECEC',
        divider: '#E5E5E5',
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },

        //
        // System components
        //

        groupped: {
            background: '#F7F7F8',
            chevron: '#8A8A8A',
            sectionTitle: '#6B6B6B',
        },
        header: {
            background: '#FFFFFF',
            tint: '#171717'
        },
        switch: {
            track: {
                active: '#0D8F6F',
                inactive: '#dddddd',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        fab: {
            background: '#171717',
            backgroundPressed: '#2F2F2F',
            icon: '#FFFFFF',
        },
        radio: {
            active: '#0D8F6F',
            inactive: '#C0C0C0',
            dot: '#0D8F6F',
        },
        modal: {
            border: 'rgba(0, 0, 0, 0.1)'
        },
        button: {
            primary: {
                background: '#171717',
                tint: '#FFFFFF',
                disabled: '#C0C0C0',
            },
            secondary: {
                tint: '#666666',
            }
        },
        input: {
            background: '#F4F4F4',
            text: '#171717',
            placeholder: '#626262',
        },
        box: {
            warning: {
                background: '#FFF8F0',
                border: '#FF9500',
                text: '#92520A',
            },
            error: {
                background: '#FFF0F0',
                border: '#FF3B30',
                text: '#B42318',
            }
        },

        //
        // App components
        //

        status: {
            connected: '#0B795E',
            connecting: '#0B795E',
            disconnected: '#62686E',
            error: '#B42318',
            default: '#62686E',
            busy: '#0057B8',
            waiting: '#92520A',
        },

        // Permission mode colors
        permission: {
            default: '#62686E',
            acceptEdits: '#0057B8',
            bypass: '#92520A',
            plan: '#0B795E',
            readOnly: '#62686E',
            safeYolo: '#B54A16',
            yolo: '#DC143C',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#0B795E',
                text: '#FFFFFF',
            },
            deny: {
                background: '#B42318',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#0057B8',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#E5E5EA',
                border: '#D1D1D6',
                text: '#8E8E93',
            },
            selected: {
                background: '#F2F2F7',
                border: '#D1D1D6',
                text: '#3C3C43',
            },
        },


        // Diff view
        diff: {
            outline: '#E0E0E0',
            success: '#28A745',
            error: '#DC3545',
            // Traditional diff colors
            addedBg: '#E6FFED',
            addedBorder: '#34D058',
            addedText: '#24292E',
            removedBg: '#FFEEF0',
            removedBorder: '#D73A49',
            removedText: '#24292E',
            contextBg: '#F6F8FA',
            contextText: '#586069',
            lineNumberBg: '#F6F8FA',
            lineNumberText: '#626A73',
            hunkHeaderBg: '#F1F8FF',
            hunkHeaderText: '#005CC5',
            leadingSpaceDot: '#E8E8E8',
            inlineAddedBg: '#ACFFA6',
            inlineAddedText: '#0A3F0A',
            inlineRemovedBg: '#FFCECB',
            inlineRemovedText: '#5A0A05',
        },

        // Message View colors
        userMessageBackground: '#F4F4F4',
        userMessageText: '#171717',
        agentMessageText: '#171717',
        agentEventText: '#6B6B6B',

        // Code/Syntax colors
        syntaxKeyword: '#1d4ed8',
        syntaxString: '#0B795E',
        syntaxComment: '#535B66',
        syntaxNumber: '#0E647B',
        syntaxFunction: '#9333ea',
        syntaxBracket1: '#B42318',
        syntaxBracket2: '#0B795E',
        syntaxBracket3: '#0E647B',
        syntaxBracket4: '#8B5E00',
        syntaxBracket5: '#5f27cd',
        syntaxDefault: '#374151',

        // Git status colors
        gitBranchText: '#535B66',
        gitFileCountText: '#535B66',
        gitAddedText: '#0B795E',
        gitRemovedText: '#B42318',

        // Terminal/Command colors
        terminal: {
            background: '#1E1E1E',
            prompt: '#34C759',
            command: '#E0E0E0',
            stdout: '#E0E0E0',
            stderr: '#FFB86C',
            error: '#FF5555',
            emptyOutput: '#9CACCC',
        },

    },

    ...sharedSpacing,
};

export const darkTheme = {
    dark: true,
    colors: {

        //
        // Main colors
        //

        text: '#ECECEC',
        textDestructive: Platform.select({ ios: '#FF453A', default: '#F48FB1' }),
        textSecondary: '#B4B4B4',
        textLink: '#19C37D',
        deleteAction: '#FF6B6B', // Delete/remove button color (same in both themes)
        warningCritical: '#FF453A',
        warning: '#B4B4B4',
        success: '#19C37D',
        surface: '#212121',
        surfaceRipple: 'rgba(255, 255, 255, 0.08)',
        surfacePressed: '#3A3A3A',
        surfaceSelected: '#343434',
        surfacePressedOverlay: '#3A3A3A',
        surfaceHigh: '#2F2F2F',
        surfaceHighest: '#424242',
        divider: '#3D3D3D',
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },

        //
        // System components
        //

        header: {
            background: '#212121',
            tint: '#ECECEC'
        },
        switch: {
            track: {
                active: '#19C37D',
                inactive: '#3a393f',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        groupped: {
            background: '#171717',
            chevron: '#8F8F8F',
            sectionTitle: '#B4B4B4',
        },
        fab: {
            background: '#ECECEC',
            backgroundPressed: '#D9D9D9',
            icon: '#212121',
        },
        radio: {
            active: '#19C37D',
            inactive: '#48484A',
            dot: '#19C37D',
        },
        modal: {
            border: 'rgba(255, 255, 255, 0.1)'
        },
        button: {
            primary: {
                background: '#ECECEC',
                tint: '#212121',
                disabled: '#565656',
            },
            secondary: {
                tint: '#B4B4B4',
            }
        },
        input: {
            background: '#2F2F2F',
            text: '#ECECEC',
            placeholder: '#9B9B9B',
        },
        box: {
            warning: {
                background: 'rgba(255, 159, 10, 0.15)',
                border: '#FF9F0A',
                text: '#FFAB00',
            },
            error: {
                background: 'rgba(255, 69, 58, 0.15)',
                border: '#FF453A',
                text: '#FF6B6B',
            }
        },

        //
        // App components
        //

        status: { // App Connection Status
            connected: '#19C37D',
            connecting: '#19C37D',
            disconnected: '#B4B4B4',
            error: '#FF8B82',
            default: '#B4B4B4',
            busy: '#86B9FF',
            waiting: '#FFC16B',
        },

        // Permission mode colors
        permission: {
            default: '#B4B4B4',
            acceptEdits: '#0A84FF',
            bypass: '#FF9F0A',
            plan: '#32D74B',
            readOnly: '#98989D',
            safeYolo: '#FF7A4C',
            yolo: '#FF453A',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#32D74B',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF453A',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#0A84FF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#2C2C2E',
                border: '#38383A',
                text: '#8E8E93',
            },
            selected: {
                background: '#1C1C1E',
                border: '#38383A',
                text: '#FFFFFF',
            },
        },


        // Diff view
        diff: {
            outline: '#30363D',
            success: '#3FB950',
            error: '#F85149',
            // Traditional diff colors for dark mode
            addedBg: '#0D2E1F',
            addedBorder: '#3FB950',
            addedText: '#C9D1D9',
            removedBg: '#3F1B23',
            removedBorder: '#F85149',
            removedText: '#C9D1D9',
            contextBg: '#161B22',
            contextText: '#8B949E',
            lineNumberBg: '#161B22',
            lineNumberText: '#6E7681',
            hunkHeaderBg: '#161B22',
            hunkHeaderText: '#58A6FF',
            leadingSpaceDot: '#2A2A2A',
            inlineAddedBg: '#2A5A2A',
            inlineAddedText: '#7AFF7A',
            inlineRemovedBg: '#5A2A2A',
            inlineRemovedText: '#FF7A7A',
        },

        // Message View colors
        userMessageBackground: '#2F2F2F',
        userMessageText: '#ECECEC',
        agentMessageText: '#ECECEC',
        agentEventText: '#B4B4B4',

        // Code/Syntax colors (brighter for dark mode)
        syntaxKeyword: '#87BFFA',
        syntaxString: '#E6B39C',
        syntaxComment: '#A3B894',
        syntaxNumber: '#B5CEA8',
        syntaxFunction: '#DCDCAA',
        syntaxBracket1: '#FFD700',
        syntaxBracket2: '#E89DE4',
        syntaxBracket3: '#70C2FF',
        syntaxBracket4: '#FFB26E',
        syntaxBracket5: '#00FF00',
        syntaxDefault: '#D4D4D4',

        // Git status colors
        gitBranchText: '#B4B4B4',
        gitFileCountText: '#B4B4B4',
        gitAddedText: '#34C759',
        gitRemovedText: '#FF8B82',

        // Terminal/Command colors
        terminal: {
            background: '#1E1E1E',
            prompt: '#32D74B',
            command: '#E0E0E0',
            stdout: '#E0E0E0',
            stderr: '#FFB86C',
            error: '#FF6B6B',
            emptyOutput: '#7B7B93',
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

export type Theme = typeof lightTheme;
