import * as React from 'react';
import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { getProjectIdentity } from '@/utils/projectIdentity';

const lightPalettes = [
    { background: '#E9F0FA', foreground: '#365E91' },
    { background: '#E4F2EE', foreground: '#276A5B' },
    { background: '#F5EDDF', foreground: '#865F24' },
    { background: '#F4E8EC', foreground: '#8B4A60' },
    { background: '#ECE9F5', foreground: '#62518C' },
    { background: '#E8EEF0', foreground: '#42616C' },
    { background: '#EDF0E1', foreground: '#617039' },
    { background: '#F3E9E4', foreground: '#8E5642' },
] as const;

const darkPalettes = [
    { background: '#1C2A3D', foreground: '#91B7E8' },
    { background: '#18322D', foreground: '#7AC2B2' },
    { background: '#352C1D', foreground: '#D8B36F' },
    { background: '#38242B', foreground: '#DB94A9' },
    { background: '#2B263A', foreground: '#B4A5DB' },
    { background: '#202F34', foreground: '#96BBC7' },
    { background: '#2B311F', foreground: '#B5C780' },
    { background: '#382720', foreground: '#DCA087' },
] as const;

export const ProjectIdentityIcon = React.memo(function ProjectIdentityIcon({
    path,
    fallback,
    size = 40,
}: {
    path: string | null | undefined;
    fallback?: string;
    size?: number;
}) {
    const { theme } = useUnistyles();
    const identity = React.useMemo(() => getProjectIdentity(path, fallback), [path, fallback]);
    const palette = (theme.dark ? darkPalettes : lightPalettes)[identity.paletteIndex];
    const iconSize = Math.round(size * 0.48);

    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
                width: size,
                height: size,
                borderRadius: Math.round(size * 0.28),
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.background,
                borderWidth: 1,
                borderColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(23,23,23,0.06)',
            }}
        >
            <Ionicons name={identity.icon} size={iconSize} color={palette.foreground} />
        </View>
    );
});
