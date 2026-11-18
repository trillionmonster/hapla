import * as React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebPreview } from '@/components/WebPreview';

export default function PreviewScreen() {
    const params = useLocalSearchParams<{ id: string; target?: string }>();
    return <><Stack.Screen options={{ title: '网页预览', headerShown: true }} /><WebPreview sessionId={params.id} initialTarget={params.target} /></>;
}
