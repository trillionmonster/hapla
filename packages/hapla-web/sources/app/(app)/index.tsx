import { useIsFocused } from '@react-navigation/native';
import { RoundButton } from '@/components/RoundButton';
import { useAuth } from '@/auth/AuthContext';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { MainView } from '@/components/MainView';
import { t } from '@/text';
import { BrandWordmark } from '@/components/BrandWordmark';

export default function Home() {
    const focused = useIsFocused();
    const auth = useAuth();
    if (!focused) return null;
    if (!auth.isAuthenticated) return <UserKeyWelcome />;
    return <MainView variant="phone" />;
}

function UserKeyWelcome() {
    const router = useRouter();
    const insets = useSafeAreaInsets();

    return (
        <ScrollView
            style={styles.screen}
            contentContainerStyle={[
                styles.container,
                { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 },
            ]}
        >
            <View style={styles.content}>
                <BrandWordmark size={40} />
                <Text style={styles.title}>{t('welcome.title')}</Text>
                <Text style={styles.subtitle}>{t('welcome.subtitle')}</Text>
                <View style={styles.buttonContainer}>
                    <RoundButton
                        title={t('connect.restoreAccount')}
                        onPress={() => router.push('/restore/manual')}
                    />
                </View>
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    content: {
        width: '100%',
        maxWidth: 400,
        alignItems: 'center',
    },
    title: {
        marginTop: 32,
        textAlign: 'center',
        fontSize: theme.typography.title.fontSize,
        lineHeight: theme.typography.title.lineHeight,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
        marginBottom: 32,
    },
    buttonContainer: {
        maxWidth: 320,
        width: '100%',
    },
}));
