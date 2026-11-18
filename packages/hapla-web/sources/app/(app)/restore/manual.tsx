import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: 440,
        paddingVertical: 32,
    },
    instructionText: {
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        ...Typography.default(),
    },
    inputLabel: {
        fontSize: theme.typography.label.fontSize,
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 16,
        borderRadius: 8,
        marginBottom: 24,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: theme.typography.code.fontSize,
        lineHeight: theme.typography.code.lineHeight,
        minHeight: 120,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
}));

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [restoreKey, setRestoreKey] = useState('');

    const handleRestore = async () => {
        const trimmedKey = restoreKey.trim();

        if (!trimmedKey) {
            Modal.alert(t('common.error'), t('connect.enterSecretKey'));
            return;
        }

        try {
            // Normalize the key (handles both base64url and formatted input)
            const normalizedKey = normalizeSecretKey(trimmedKey);

            // Validate the secret key format
            const secretBytes = decodeBase64(normalizedKey, 'base64url');
            if (secretBytes.length !== 32) {
                throw new Error('Invalid secret key length');
            }

            // Get token from secret
            const token = await authGetToken(secretBytes);
            if (!token) {
                throw new Error('Failed to authenticate with provided key');
            }

            // Login with new credentials
            await auth.login(token, normalizedKey);

            // Dismiss
            router.back();

        } catch (error) {
            console.error('Restore error:', error);
            Modal.alert(t('common.error'), t('connect.invalidSecretKey'));
        }
    };

    return (
        <ScrollView style={styles.scrollView} keyboardShouldPersistTaps="handled">
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.instructionText}>
                        {t('connect.loginInstructions')}
                    </Text>
                    <Text nativeID="user-key-label" style={styles.inputLabel}>
                        {t('connect.userKeyLabel')}
                    </Text>
                    <TextInput
                        style={styles.textInput}
                        accessibilityLabel={t('connect.userKeyLabel')}
                        placeholder={t('connect.userKeyLabel')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={restoreKey}
                        onChangeText={setRestoreKey}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        autoComplete="off"
                        multiline={true}
                        numberOfLines={4}
                    />

                    <RoundButton
                        title={t('connect.restoreAccount')}
                        action={handleRestore}
                    />
                </View>
            </View>
        </ScrollView>
    );
}
