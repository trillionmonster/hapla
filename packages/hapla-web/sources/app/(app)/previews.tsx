import * as React from 'react';
import { Stack } from 'expo-router';
import { ActivityIndicator } from 'react-native';
const PreviewManager = React.lazy(() => import('@/components/PreviewManager').then(module => ({ default: module.PreviewManager })));
export default function PreviewsScreen() {
    return <><Stack.Screen options={{ title: '代理管理', headerTitle: '代理管理', headerShown: true }} /><React.Suspense fallback={<ActivityIndicator accessibilityLabel="正在加载代理管理" />}><PreviewManager /></React.Suspense></>;
}
