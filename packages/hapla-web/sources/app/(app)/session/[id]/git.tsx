import React from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
const GitWorkbenchView = React.lazy(() => import('@/components/GitWorkbenchView'));
export default function GitScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <><Stack.Screen options={{ headerShown: Platform.OS !== 'web' }} /><React.Suspense fallback={<ActivityIndicator />}><GitWorkbenchView sessionId={id} /></React.Suspense></>;
}
