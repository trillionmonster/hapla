import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { randomId } from '@/utils/randomId';
import { sessionFileUploadAbort } from '@/sync/ops';
import { formatFileSize } from '@/utils/workspaceFileTransfer';
import { ATTACHMENT_ACCEPT, attachmentDestination, attachmentTypeAllowed, MAX_ATTACHMENT_BYTES, uploadAttachment, type AttachmentUploadCheckpoint, type UploadedWorkspaceAttachment } from '@/utils/workspaceAttachments';

type Entry = {
    id: string; file: File; path: string; target?: string; checkpoint?: AttachmentUploadCheckpoint;
    state: 'queued' | 'hashing' | 'uploading' | 'ready' | 'error'; progress: number; error?: string;
    uploaded?: UploadedWorkspaceAttachment;
};

export function useWorkspaceAttachments(options: { scope: string; active: boolean; prepareSession: () => Promise<string> }) {
    const { theme } = useUnistyles();
    const [entries, setEntries] = React.useState<Entry[]>([]);
    const entriesRef = React.useRef(entries); entriesRef.current = entries;
    const input = React.useRef<HTMLInputElement | null>(null);
    const controllers = React.useRef(new Map<string, AbortController>());
    const generation = React.useRef(0);
    const change = (id: string, patch: Partial<Entry>) => {
        const next = entriesRef.current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
        entriesRef.current = next; setEntries(next);
    };
    const remove = (id: string) => {
        const entry = entriesRef.current.find((candidate) => candidate.id === id);
        controllers.current.get(id)?.abort(); controllers.current.delete(id);
        if (entry?.checkpoint) void sessionFileUploadAbort(entry.checkpoint.sessionId, entry.checkpoint.uploadId).catch(() => undefined);
        const next = entriesRef.current.filter((candidate) => candidate.id !== id);
        entriesRef.current = next; setEntries(next);
    };
    const clear = React.useCallback(() => {
        generation.current++;
        for (const controller of controllers.current.values()) controller.abort();
        controllers.current.clear();
        for (const entry of entriesRef.current) if (entry.checkpoint) void sessionFileUploadAbort(entry.checkpoint.sessionId, entry.checkpoint.uploadId).catch(() => undefined);
        entriesRef.current = []; setEntries([]);
    }, []);
    React.useEffect(() => {
        if (!options.active) clear();
        return clear;
    }, [options.scope, options.active, clear]);

    const uploadOne = async (id: string, target: string): Promise<UploadedWorkspaceAttachment | null> => {
        let entry = entriesRef.current.find((candidate) => candidate.id === id);
        if (!entry) return null;
        if (controllers.current.has(id)) throw new Error('附件正在上传，请等待完成');
        if (entry.uploaded && entry.target === target) return entry.uploaded;
        if (entry.target && entry.target !== target) {
            if (entry.checkpoint) await sessionFileUploadAbort(entry.target, entry.checkpoint.uploadId).catch(() => undefined);
            change(id, { path: attachmentDestination(entry.file.name, randomId()), checkpoint: undefined, uploaded: undefined });
            entry = entriesRef.current.find((candidate) => candidate.id === id)!;
        }
        const version = generation.current;
        const controller = new AbortController(); controllers.current.set(id, controller);
        change(id, { target, state: 'hashing', error: undefined, progress: 0 });
        try {
            const uploaded = await uploadAttachment({
                sessionId: target, file: entry.file, path: entry.path, signal: controller.signal, checkpoint: entry.checkpoint,
                onCheckpoint: (checkpoint) => { if (version === generation.current) change(id, { checkpoint }); },
                onProgress: (state, progress) => { if (version === generation.current) change(id, { state, progress }); },
            });
            if (version !== generation.current || controller.signal.aborted) throw new DOMException('附件已取消', 'AbortError');
            change(id, { state: 'ready', progress: 1, uploaded });
            return uploaded;
        } catch (error) {
            if (version === generation.current && !controller.signal.aborted) change(id, { state: 'error', error: error instanceof Error ? error.message : '上传失败' });
            throw error;
        } finally { if (controllers.current.get(id) === controller) controllers.current.delete(id); }
    };
    const add = (files: File[]) => {
        const accepted = files.filter((file) => file.size <= MAX_ATTACHMENT_BYTES && attachmentTypeAllowed(file));
        if (accepted.length !== files.length) Modal.alert('附件不符合限制', `单个文件上限为 ${formatFileSize(MAX_ATTACHMENT_BYTES)}；允许类型：${ATTACHMENT_ACCEPT === '*' ? '任意文件' : ATTACHMENT_ACCEPT}`);
        const slots = Math.max(0, 16 - entriesRef.current.length);
        if (accepted.length > slots) Modal.alert('附件数量超限', '每条消息最多附带 16 个文件');
        const next = [...entriesRef.current, ...accepted.slice(0, slots).map((file): Entry => {
            const id = randomId();
            return { id, file, path: attachmentDestination(file.name, id), state: 'queued', progress: 0 };
        })];
        entriesRef.current = next; setEntries(next);
    };
    const retry = (id: string) => { void options.prepareSession().then((target) => uploadOne(id, target)).catch((error) => Modal.alert('上传失败', error instanceof Error ? error.message : '请重试')); };
    return {
        count: entries.length,
        pick: Platform.OS === 'web' ? () => {
            if (!input.current) { Modal.alert('无法打开文件选择器', '请重新打开此会话后重试'); return; }
            input.current.click();
        } : undefined,
        clear,
        uploadAll: async (target: string) => {
            const version = generation.current;
            const uploaded: UploadedWorkspaceAttachment[] = [];
            for (const entry of [...entriesRef.current]) {
                if (version !== generation.current) throw new DOMException('附件已取消', 'AbortError');
                const result = await uploadOne(entry.id, target);
                if (result) uploaded.push(result);
            }
            return uploaded;
        },
        input: Platform.OS === 'web' ? React.createElement('input', {
            ref: input, type: 'file', multiple: true, accept: ATTACHMENT_ACCEPT === '*' ? undefined : ATTACHMENT_ACCEPT,
            'aria-label': '选择附件文件', style: { display: 'none' },
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const files = Array.from(event.currentTarget.files || []);
                event.currentTarget.value = '';
                try { add(files); } catch (error) { Modal.alert('添加附件失败', error instanceof Error ? error.message : '请重试'); }
            },
        }) : null,
        preview: Platform.OS === 'web' && entries.length > 0 ? <View style={{ paddingHorizontal: 12, gap: 4 }}>
            {entries.map((entry) => <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.typography.small.fontSize }}>{entry.file.name} · {formatFileSize(entry.file.size)}</Text>
                    <Text style={{ color: entry.state === 'error' ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>
                        {entry.state === 'queued' ? '随消息上传' : entry.state === 'ready' ? '已校验，待发送' : entry.state === 'error' ? entry.error : `${entry.state === 'hashing' ? '正在校验' : '正在上传'} ${Math.round(entry.progress * 100)}%`}
                    </Text>
                </View>
                {entry.state === 'error' && <Pressable accessibilityRole="button" accessibilityLabel={`重试上传 ${entry.file.name}`} onPress={() => retry(entry.id)} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><Text style={{ color: theme.colors.text }}>重试</Text></Pressable>}
                <Pressable accessibilityRole="button" accessibilityLabel={`取消附件 ${entry.file.name}`} onPress={() => remove(entry.id)} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><Text style={{ color: theme.colors.text }}>取消</Text></Pressable>
            </View>)}
        </View> : null,
    };
}
