import * as React from 'react';
import { Linking, View } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/StyledText';
import { getMediaKind } from './mediaKind';
import { mediaFallbackLink } from './mediaFallbackLink';
import type { VideoPreview, WorkspaceVideo } from './videoPreview';

export type MessageMedia = {
    mediaType: string;
    data?: string;
    url?: string;
    name?: string;
    size?: number;
    video?: VideoPreview;
    workspaceVideo?: WorkspaceVideo;
    /** Original local source for downloads, independent of preview lifetime. */
    workspaceFile?: { sessionId: string; path: string };
    /** A new artifact event may overwrite the same path; only its metadata cache changes. */
    previewRevision?: string;
};

export function MediaGallery(props: { media: MessageMedia[] }) {
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {props.media.map((item, index) => {
                const uri = item.url ?? (item.data ? `data:${item.mediaType};base64,${item.data}` : null);
                if (!uri) {
                    return null;
                }
                const kind = getMediaKind(uri, item.mediaType);
                if (kind === 'unknown') {
                    const href = mediaFallbackLink(uri);
                    return <Text
                        key={`${uri.slice(0, 40)}:${index}`}
                        accessibilityRole={href ? 'link' : undefined}
                        onPress={href ? () => { void Linking.openURL(href); } : undefined}
                        style={href ? { textDecorationLine: 'underline' } : undefined}
                    >{item.name || uri}</Text>;
                }
                if (kind === 'video' || kind === 'audio') {
                    return (
                        <View
                            key={`${uri.slice(0, 40)}:${index}`}
                            style={{ width: 220, height: 140, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' }}
                        >
                            <Text style={{ color: '#FFF' }}>{kind === 'audio' ? 'Audio' : 'Video'} playback is available on Web</Text>
                        </View>
                    );
                }
                return (
                    <Image
                        key={`${uri.slice(0, 40)}:${index}`}
                        source={{ uri }}
                        style={{ width: 220, height: 180, borderRadius: 8 }}
                        contentFit="contain"
                        transition={160}
                    />
                );
            })}
        </View>
    );
}
