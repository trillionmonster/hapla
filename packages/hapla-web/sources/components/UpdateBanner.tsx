import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { useUpdates } from '@/hooks/useUpdates';
import { useNativeUpdate } from '@/hooks/useNativeUpdate';
import { Linking, Platform } from 'react-native';
import { t } from '@/text';

const NativeUpdateBanner = React.memo(() => {
    const { theme } = useUnistyles();
    const { updateAvailable, reloadApp } = useUpdates();
    const updateUrl = useNativeUpdate();

    // Show native app update banner (highest priority)
    if (updateUrl) {
        const handleOpenStore = async () => {
            try {
                const supported = await Linking.canOpenURL(updateUrl);
                if (supported) {
                    await Linking.openURL(updateUrl);
                }
            } catch (error) {
                console.error('Error opening app store:', error);
            }
        };

        return (
            <ItemGroup>
                <Item
                    title={t('updateBanner.nativeUpdateAvailable')}
                    subtitle={Platform.OS === 'ios' ? t('updateBanner.tapToUpdateAppStore') : t('updateBanner.tapToUpdatePlayStore')}
                    icon={<Ionicons name="download-outline" size={28} color={theme.colors.success} />}
                    showChevron={true}
                    onPress={handleOpenStore}
                />
            </ItemGroup>
        );
    }

    // Show OTA update banner if available (second priority)
    if (updateAvailable) {
        return (
            <ItemGroup>
                <Item
                    title={t('updateBanner.updateAvailable')}
                    subtitle={t('updateBanner.pressToApply')}
                    icon={<Ionicons name="download-outline" size={28} color={theme.colors.success} />}
                    showChevron={false}
                    onPress={reloadApp}
                />
            </ItemGroup>
        );
    }

    return null;
});

// Web releases are monitored silently by the root layout. They must not add
// update prompts to the session list or interrupt an active conversation.
export const UpdateBanner = React.memo(() => (
    Platform.OS === 'web' ? null : <NativeUpdateBanner />
));
