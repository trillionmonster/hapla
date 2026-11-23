import * as React from 'react';
import type { VoiceInputFeedback, VoiceInputProps } from './VoiceInput';
import { VOICE_INPUT_ENABLED } from './uiFeatures';
export type { VoiceInputFeedback } from './VoiceInput';

const load = () => import('./VoiceInput');
const LazyInput = React.lazy(() => load().then(module => ({ default: module.VoiceInput })));
const LazyStatus = React.lazy(() => load().then(module => ({ default: module.VoiceInputStatus })));

export function VoiceInput(props: VoiceInputProps) {
    return VOICE_INPUT_ENABLED ? <React.Suspense fallback={null}><LazyInput {...props} /></React.Suspense> : null;
}
export function VoiceInputStatus(props: { feedback: VoiceInputFeedback | null }) {
    return VOICE_INPUT_ENABLED ? <React.Suspense fallback={null}><LazyStatus {...props} /></React.Suspense> : null;
}
