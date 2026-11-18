import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
}

/**
 * Browser layout intentionally avoids native keyboard-controller APIs. Modern
 * mobile browsers resize the dynamic viewport while the on-screen keyboard is
 * open, so a flex column tracks it without double-applying keyboard padding.
 */
export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder }) => {
    const headerHeight = useHeaderHeight();

    return (
        <View style={{ flexBasis: 0, flexGrow: 1, minHeight: 0 }}>
            <View style={{ flexBasis: 0, flexGrow: 1, minHeight: 0 }}>
                {content ? (
                    <View style={{ position: 'absolute', inset: 0 } as any}>
                        {content}
                    </View>
                ) : null}
                {placeholder ? (
                    <ScrollView
                        style={{ position: 'absolute', top: headerHeight, left: 0, right: 0, bottom: 0 }}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flexGrow: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                ) : null}
            </View>
            <View style={{ flexShrink: 0, paddingBottom: 'env(safe-area-inset-bottom)' } as any}>
                {input}
            </View>
        </View>
    );
});
