import * as React from 'react';
import { Image } from 'expo-image';
import { Text, View } from 'react-native';
import { useSetting } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
    flavor?: string | null;
    imageUrl?: string | null;
    thumbhash?: string | null;
}

const palette = [
    ['#102A43', '#38BDF8'],
    ['#312E81', '#A78BFA'],
    ['#064E3B', '#34D399'],
    ['#7C2D12', '#FB923C'],
    ['#701A75', '#F0ABFC'],
    ['#881337', '#FB7185'],
] as const;

function hashCode(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export const Avatar = React.memo((props: AvatarProps) => {
    const { theme } = useUnistyles();
    const showFlavorIcons = useSetting('showFlavorIcons');
    const size = props.size ?? 48;
    const radius = props.square ? 4 : size / 2;
    const hash = hashCode(props.id);
    const colors = props.monochrome ? ['#787878', '#B6B6B6'] : palette[hash % palette.length];
    const flavor = props.flavor === 'codex' ? 'C' : 'A';
    const badgeSize = Math.max(14, Math.round(size * 0.34));

    const avatar = props.imageUrl ? (
        <Image
            source={{ uri: props.imageUrl, thumbhash: props.thumbhash || undefined }}
            placeholder={props.thumbhash ? { thumbhash: props.thumbhash } : undefined}
            contentFit="cover"
            transition={120}
            style={{ width: size, height: size, borderRadius: radius }}
        />
    ) : (
        <View
            accessibilityLabel={props.title ? `Avatar ${props.id}` : undefined}
            style={{
                width: size,
                height: size,
                borderRadius: radius,
                overflow: 'hidden',
                backgroundColor: colors[0],
                backgroundImage: `linear-gradient(${35 + (hash % 110)}deg, ${colors[0]}, ${colors[1]})`,
                position: 'relative',
            } as any}
        >
            <View style={{
                position: 'absolute',
                width: size * 0.62,
                height: size * 0.62,
                borderRadius: size * 0.16,
                backgroundColor: 'rgba(255,255,255,0.18)',
                transform: [{ rotate: `${hash % 90}deg` }],
                left: (hash % 17) - size * 0.12,
                top: ((hash >>> 5) % 17) - size * 0.12,
            }} />
        </View>
    );

    if (!showFlavorIcons || props.flavor === null) return avatar;

    return (
        <View style={{ width: size, height: size, position: 'relative' }}>
            {avatar}
            <View style={{
                position: 'absolute',
                right: -2,
                bottom: -2,
                width: badgeSize,
                height: badgeSize,
                borderRadius: badgeSize / 2,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.divider,
            }}>
                <Text style={{ color: theme.colors.text, fontSize: badgeSize * 0.52, fontWeight: '700' }}>{flavor}</Text>
            </View>
        </View>
    );
});
