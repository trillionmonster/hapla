import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import {
    machineReadCliSkill,
    machineSaveCliSkill,
    machineTrashCliSkill,
    type CliSkillProvider,
} from '@/sync/ops';
import { layout } from '@/components/layout';

export default function SkillEditorScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{
        machineId: string;
        provider: CliSkillProvider;
        path?: string;
        name?: string;
    }>();
    const isNew = !params.path;
    const [name, setName] = React.useState(params.name || '');
    const [description, setDescription] = React.useState('');
    const [source, setSource] = React.useState('');
    const [interactiveEnabled, setInteractiveEnabled] = React.useState(false);
    const [interactiveId, setInteractiveId] = React.useState('');
    const [interactiveDisplayName, setInteractiveDisplayName] = React.useState('');
    const [interactiveCommand, setInteractiveCommand] = React.useState('node');
    const [interactiveArgs, setInteractiveArgs] = React.useState('./server.mjs');
    const [interactiveEnv, setInteractiveEnv] = React.useState('');
    const [editable, setEditable] = React.useState(isNew);
    const [loading, setLoading] = React.useState(!isNew);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!params.path || !params.machineId || !params.provider) return;
        let cancelled = false;
        void machineReadCliSkill({
            machineId: params.machineId,
            provider: params.provider,
            path: params.path,
        }).then((result) => {
            if (cancelled) return;
            setSource(result.source);
            setEditable(result.editable);
            if (result.interactiveManifest) {
                const manifest = JSON.parse(result.interactiveManifest);
                setInteractiveEnabled(true);
                setInteractiveId(manifest.id ?? '');
                setInteractiveDisplayName(manifest.displayName ?? '');
                setInteractiveCommand(manifest.mcpServer?.command ?? 'node');
                setInteractiveArgs(Array.isArray(manifest.mcpServer?.args) ? manifest.mcpServer.args.join('\n') : '');
                setInteractiveEnv(Array.isArray(manifest.mcpServer?.envFromHost) ? manifest.mcpServer.envFromHost.join('\n') : '');
            }
            setError(null);
        }).catch((nextError) => {
            if (!cancelled) setError(nextError instanceof Error ? nextError.message : 'Could not load skill source');
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [params.machineId, params.path, params.provider]);

    const save = React.useCallback(async () => {
        if (!params.machineId || !params.provider || !name.trim()) {
            setError('Enter a lowercase skill name before saving.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const interactiveManifest = params.provider === 'codex' && interactiveEnabled
                ? JSON.stringify({
                    schemaVersion: 1,
                    id: interactiveId.trim() || name.trim().replace(/_/g, '-'),
                    ...(interactiveDisplayName.trim() ? { displayName: interactiveDisplayName.trim() } : {}),
                    mcpServer: {
                        command: interactiveCommand.trim(),
                        args: interactiveArgs.split('\n').map((item) => item.trim()).filter(Boolean),
                        envFromHost: interactiveEnv.split('\n').map((item) => item.trim()).filter(Boolean),
                    },
                }, null, 2)
                : params.provider === 'codex' ? null : undefined;
            await machineSaveCliSkill({
                machineId: params.machineId,
                provider: params.provider,
                name: name.trim(),
                description: description.trim(),
                source,
                interactiveManifest,
                path: params.path || null,
            });
            router.back();
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : 'Could not save skill');
        } finally {
            setSaving(false);
        }
    }, [description, interactiveArgs, interactiveCommand, interactiveDisplayName, interactiveEnabled, interactiveEnv, interactiveId, name, params.machineId, params.path, params.provider, router, source]);

    const trash = React.useCallback(async () => {
        if (!params.path || !params.machineId || !params.provider) return;
        const confirmed = await Modal.confirm(
            'Remove this skill?',
            'Hapla will move it to ~/.hapla/trash/skills so it can be recovered.',
            { confirmText: 'Move to trash', destructive: true },
        );
        if (!confirmed) return;
        setSaving(true);
        try {
            await machineTrashCliSkill({
                machineId: params.machineId,
                provider: params.provider,
                path: params.path,
            });
            router.back();
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : 'Could not remove skill');
        } finally {
            setSaving(false);
        }
    }, [params.machineId, params.path, params.provider, router]);

    if (loading) {
        return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}><ActivityIndicator /></View>;
    }

    const fieldStyle = {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: theme.typography.body.fontSize,
        outlineStyle: 'none',
    } as const;

    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface }} contentContainerStyle={{ padding: 20 }}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', gap: 18 }}>
                <View>
                    <Text style={{ color: theme.colors.text, fontSize: theme.typography.title.fontSize, ...Typography.default('semiBold') }}>
                        {isNew ? `Create ${params.provider || 'CLI'} skill` : name || 'Skill source'}
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 5, lineHeight: 20 }}>
                        {editable ? 'Changes are written to the CLI skill directory on this machine.' : 'This system skill is available for inspection but cannot be changed.'}
                    </Text>
                </View>

                {isNew ? (
                    <>
                        <View style={{ gap: 7 }}>
                            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>Name</Text>
                            <TextInput
                                value={name}
                                onChangeText={setName}
                                editable={editable && !saving}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="review-code"
                                placeholderTextColor={theme.colors.input.placeholder}
                                style={fieldStyle as any}
                            />
                            <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>Lowercase letters, numbers, hyphens and underscores only.</Text>
                        </View>
                        <View style={{ gap: 7 }}>
                            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>Description</Text>
                            <TextInput
                                value={description}
                                onChangeText={setDescription}
                                editable={editable && !saving}
                                placeholder="When this skill should be used"
                                placeholderTextColor={theme.colors.input.placeholder}
                                style={fieldStyle as any}
                            />
                        </View>
                    </>
                ) : null}

                <View style={{ gap: 7 }}>
                    <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {isNew ? 'Instructions' : 'SKILL.md'}
                    </Text>
                    <TextInput
                        value={source}
                        onChangeText={setSource}
                        editable={editable && !saving}
                        multiline
                        textAlignVertical="top"
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={isNew ? 'Describe the workflow, constraints and expected output.' : undefined}
                        placeholderTextColor={theme.colors.input.placeholder}
                        style={{ ...fieldStyle, minHeight: 360, fontSize: theme.typography.code.fontSize, lineHeight: theme.typography.code.lineHeight, ...Typography.mono() } as any}
                    />
                </View>

                {params.provider === 'codex' ? (
                    <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh }}>
                        <Pressable
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: interactiveEnabled, disabled: !editable || saving }}
                            disabled={!editable || saving}
                            onPress={() => setInteractiveEnabled((value) => !value)}
                            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                        >
                            <Ionicons
                                name={interactiveEnabled ? 'checkbox' : 'square-outline'}
                                size={22}
                                color={interactiveEnabled ? theme.colors.textLink : theme.colors.textSecondary}
                            />
                            <View style={{ flex: 1 }}>
                                <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>Interactive web workspace</Text>
                                <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, marginTop: 2 }}>
                                    Start an MCP service with this Skill and host its HTML resource inside the active Hapla session.
                                </Text>
                            </View>
                        </Pressable>

                        {interactiveEnabled ? (
                            <>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                    <View style={{ flex: 1, minWidth: 180, gap: 6 }}>
                                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>Service ID</Text>
                                        <TextInput value={interactiveId} onChangeText={setInteractiveId} editable={editable && !saving} autoCapitalize="none" autoCorrect={false} placeholder={name.replace(/_/g, '-') || 'character-composer'} placeholderTextColor={theme.colors.input.placeholder} style={fieldStyle as any} />
                                    </View>
                                    <View style={{ flex: 1, minWidth: 180, gap: 6 }}>
                                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>Display name</Text>
                                        <TextInput value={interactiveDisplayName} onChangeText={setInteractiveDisplayName} editable={editable && !saving} placeholder="Character composer" placeholderTextColor={theme.colors.input.placeholder} style={fieldStyle as any} />
                                    </View>
                                </View>
                                <View style={{ gap: 6 }}>
                                    <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>MCP command</Text>
                                    <TextInput value={interactiveCommand} onChangeText={setInteractiveCommand} editable={editable && !saving} autoCapitalize="none" autoCorrect={false} placeholder="node" placeholderTextColor={theme.colors.input.placeholder} style={{ ...fieldStyle, ...Typography.mono() } as any} />
                                </View>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                    <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
                                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>Arguments · one per line</Text>
                                        <TextInput value={interactiveArgs} onChangeText={setInteractiveArgs} editable={editable && !saving} multiline autoCapitalize="none" autoCorrect={false} placeholder={'./server.mjs\n--stdio'} placeholderTextColor={theme.colors.input.placeholder} style={{ ...fieldStyle, minHeight: 94, ...Typography.mono() } as any} />
                                    </View>
                                    <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
                                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>Host environment allowlist · one per line</Text>
                                        <TextInput value={interactiveEnv} onChangeText={setInteractiveEnv} editable={editable && !saving} multiline autoCapitalize="characters" autoCorrect={false} placeholder={'MODEL_API_KEY\nMODEL_BASE_URL'} placeholderTextColor={theme.colors.input.placeholder} style={{ ...fieldStyle, minHeight: 94, ...Typography.mono() } as any} />
                                    </View>
                                </View>
                                <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight }}>
                                    Relative executable and argument paths must stay inside the Skill directory. Only allowlisted environment variables are passed to the service.
                                </Text>
                            </>
                        ) : null}
                    </View>
                ) : null}

                {error ? (
                    <View style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text selectable style={{ color: theme.colors.textDestructive }}>{error}</Text>
                    </View>
                ) : null}

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                    {!isNew && editable ? (
                        <Pressable
                            accessibilityRole="button"
                            disabled={saving}
                            onPress={() => void trash()}
                            style={{ minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', gap: 7, alignItems: 'center', borderRadius: 8, backgroundColor: theme.colors.surfaceHigh }}
                        >
                            <Ionicons name="trash-outline" size={18} color={theme.colors.textDestructive} />
                            <Text style={{ color: theme.colors.textDestructive, ...Typography.default('semiBold') }}>Remove</Text>
                        </Pressable>
                    ) : <View />}
                    {editable ? (
                        <Pressable
                            accessibilityRole="button"
                            disabled={saving}
                            onPress={() => void save()}
                            style={{ minWidth: 110, minHeight: 44, paddingHorizontal: 18, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: theme.colors.button.primary.background, opacity: saving ? 0.65 : 1 }}
                        >
                            {saving ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} /> : <Ionicons name="save-outline" size={18} color={theme.colors.button.primary.tint} />}
                            <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>Save</Text>
                        </Pressable>
                    ) : null}
                </View>
            </View>
        </ScrollView>
    );
}
