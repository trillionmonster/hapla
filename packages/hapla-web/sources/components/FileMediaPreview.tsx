import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import type { FilePreviewKind } from '@/utils/filePreview';
import type { WorkspaceVideoLease } from '@/utils/workspaceVideoCache';
import type { CloudMediaAttachment } from '@/utils/cloudFileDelivery';

export function FileMediaPreview(props: {
    base64?: string;
    url?: string;
    attachVideo?: WorkspaceVideoLease['attach'];
    attachMedia?: CloudMediaAttachment;
    onError?: (message: string) => void;
    fileName: string;
    kind: Exclude<FilePreviewKind, 'text' | 'binary'>;
    mimeType: string;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: theme.colors.textSecondary, textAlign: 'center', ...Typography.default() }}>
                {props.fileName} can be previewed in the Hapla Web workspace.
            </Text>
        </View>
    );
}
