import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { useUnistyles } from 'react-native-unistyles';
import { createHeader } from './Header';
import { WorkspaceControl, useWorkspaceControlStyle } from '../WorkspaceControl.web';

export function FilePreviewHeader(props: NativeStackHeaderProps) {
    const { width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const style = useWorkspaceControlStyle();
    if (width <= 700) return createHeader(props);

    const close = () => {
        const sessionId = (props.route.params as { id?: string } | undefined)?.id;
        const state = props.navigation.getState();
        const previous = state.routes[state.index - 1];
        const previousSessionId = (previous?.params as { id?: string } | undefined)?.id;
        // Expo also copies a deep link's id onto the initial index route. Only
        // actual session screens are valid origins; index renders blank on PC.
        const previousIsSessionScreen = previous?.name.startsWith('session/[id]') && previous.name !== 'session/[id]/file';
        if (props.navigation.canGoBack() && previousSessionId === sessionId && previousIsSessionScreen) {
            props.navigation.goBack();
        } else if (sessionId) {
            props.navigation.replace('session/[id]', { id: sessionId });
        } else {
            props.navigation.replace('index');
        }
    };
    return (
        <div className="hapla-file-preview-header" style={style}>
            <div className="hapla-file-preview-title">
                <Ionicons name="document-text-outline" size={17} color={theme.colors.textSecondary} aria-hidden />
                <span>File preview</span>
            </div>
            <WorkspaceControl icon="close-outline" label="关闭" accessibilityLabel="关闭文件预览" title="关闭预览，返回工作区" variant="close" onClick={close} />
        </div>
    );
}
