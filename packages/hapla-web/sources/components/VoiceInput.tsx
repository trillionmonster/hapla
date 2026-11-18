import * as React from 'react';
export type VoiceInputFeedback = {
    message: string;
    partial?: string;
    error?: boolean;
    action?: { label: string; onPress: () => void };
    dismiss?: () => void;
};
export type VoiceInputProps = {
    value: string;
    onChangeText: (value: string) => void;
    onBusyChange?: (busy: boolean) => void;
    onFeedbackChange?: (feedback: VoiceInputFeedback | null) => void;
    scope?: string;
};
export function VoiceInput(_props: VoiceInputProps) { return null; }
export function VoiceInputStatus(_props: { feedback: VoiceInputFeedback | null }) { return null; }
