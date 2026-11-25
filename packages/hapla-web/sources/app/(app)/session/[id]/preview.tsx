import * as React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator } from 'react-native';
const WebPreview = React.lazy(() => import('@/components/WebPreview').then(module => ({ default: module.WebPreview })));

export default function PreviewScreen() {
    const params = useLocalSearchParams<{ id: string; target?: string }>();
    return <><Stack.Screen options={{ title: '网页预览', headerShown: true }} /><React.Suspense fallback={<ActivityIndicator accessibilityLabel="正在加载网页预览" />}><WebPreview sessionId={params.id} initialTarget={params.target} /></React.Suspense></>;
}
