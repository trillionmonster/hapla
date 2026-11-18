import * as React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { Avatar } from '@/components/Avatar';
import { SessionActionsNativeMenu } from '@/components/SessionActionsNativeMenu';
import { SessionActionsAnchor } from '@/components/SessionActionsPopover';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { useHeaderHeight } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { StyleSheet,  useUnistyles } from 'react-native-unistyles';

interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
    onBackPress?: () => void;
    onAvatarPress?: () => void;
    avatarId?: string;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    onAvatarMenuRequest?: (anchor: SessionActionsAnchor) => void;
    avatarMenuExpanded?: boolean;
    avatarMenuSession?: Session | null;
    onAfterAvatarArchive?: () => void;
    onAfterAvatarDelete?: () => void;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    subtitle,
    onBackPress,
    onAvatarPress,
    avatarId,
    isConnected = true,
    flavor,
    onAvatarMenuRequest,
    avatarMenuExpanded = false,
    avatarMenuSession,
    onAfterAvatarArchive,
    onAfterAvatarDelete,
}) => {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const avatarAnchorRef = React.useRef<View | null>(null);
    const suppressAvatarPressUntilRef = React.useRef(0);

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            navigation.goBack();
        }
    };

    const requestAvatarMenuFromTrigger = React.useCallback(() => {
        if (!onAvatarMenuRequest || !avatarAnchorRef.current) {
            return;
        }

        suppressAvatarPressUntilRef.current = Date.now() + 750;
        avatarAnchorRef.current.measureInWindow((x, y, width, height) => {
            onAvatarMenuRequest({
                type: 'rect',
                x,
                y,
                width,
                height,
            });
        });
    }, [onAvatarMenuRequest]);

    const handleAvatarPress = React.useCallback(() => {
        if (Date.now() < suppressAvatarPressUntilRef.current) {
            return;
        }
        onAvatarPress?.();
    }, [onAvatarPress]);

    const handleAvatarContextMenu = React.useCallback((event: any) => {
        if (!onAvatarMenuRequest) {
            return;
        }

        event.preventDefault?.();
        event.stopPropagation?.();
        suppressAvatarPressUntilRef.current = Date.now() + 750;
        onAvatarMenuRequest({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, [onAvatarMenuRequest]);

    const handleAvatarKeyDown = React.useCallback((event: any) => {
        const key = event.nativeEvent?.key;
        const shiftKey = !!event.nativeEvent?.shiftKey;
        if (key === 'ContextMenu' || (shiftKey && key === 'F10')) {
            event.preventDefault?.();
            requestAvatarMenuFromTrigger();
        }
    }, [requestAvatarMenuFromTrigger]);

    const webAvatarMenuProps = Platform.OS === 'web' && onAvatarMenuRequest ? {
        'aria-expanded': avatarMenuExpanded,
        'aria-haspopup': 'menu',
        onContextMenu: handleAvatarContextMenu,
        onKeyDown: handleAvatarKeyDown,
    } as any : {};

    return (
        <View style={[styles.container, { paddingTop: Platform.OS === 'web' ? 'env(safe-area-inset-top)' : insets.top, backgroundColor: theme.colors.header.background } as any]}>
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight }]}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={handleBackPress} style={styles.backButton}>
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color={theme.colors.header.tint}
                        />
                    </Pressable>

                    <View style={styles.titleContainer}>
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.title,
                                {
                                    color: theme.colors.header.tint,
                                    ...Typography.default('semiBold')
                                }
                            ]}
                        >
                            {title}
                        </Text>
                        {subtitle && (
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[
                                    styles.subtitle,
                                    {
                                        color: theme.colors.header.tint,
                                        opacity: 0.7,
                                        ...Typography.default()
                                    }
                                ]}
                            >
                                {subtitle}
                            </Text>
                        )}
                    </View>

                    {avatarId && onAvatarPress && (
                        <View collapsable={false} ref={avatarAnchorRef} style={styles.avatarButtonSlot}>
                            {avatarMenuSession ? (
                                <SessionActionsNativeMenu
                                    onAfterArchive={onAfterAvatarArchive}
                                    onAfterDelete={onAfterAvatarDelete}
                                    session={avatarMenuSession}
                                >
                                    <Pressable
                                        hitSlop={15}
                                        onPress={handleAvatarPress}
                                        style={styles.avatarButton}
                                        {...webAvatarMenuProps}
                                    >
                                        <Avatar
                                            id={avatarId}
                                            size={32}
                                            monochrome={!isConnected}
                                            flavor={flavor}
                                        />
                                    </Pressable>
                                </SessionActionsNativeMenu>
                            ) : (
                                <Pressable
                                    hitSlop={15}
                                    onPress={handleAvatarPress}
                                    style={styles.avatarButton}
                                    {...webAvatarMenuProps}
                                >
                                    <Avatar
                                        id={avatarId}
                                        size={32}
                                        monochrome={!isConnected}
                                        flavor={flavor}
                                    />
                                </Pressable>
                            )}
                        </View>
                    )}
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.OS === 'ios' ? 8 : 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    backButton: {
        width: 44,
        height: 44,
        marginLeft: -8,
        marginRight: 4,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
    },
    title: {
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        fontWeight: '600',
        marginBottom: 1,
        width: '100%',
    },
    subtitle: {
        fontSize: theme.typography.caption.fontSize,
        fontWeight: '400',
        lineHeight: theme.typography.caption.lineHeight,
    },
    avatarButtonSlot: {
        marginRight: Platform.select({ ios: -8, default: -8 }),
        overflow: 'visible',
    },
    avatarButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
