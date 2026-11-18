import * as React from 'react';
import type { CodexPreferences } from '@/sync/codexPreferences';
import type { EffortLevel } from './modelModeOptions';
export type CodexControlsProps = {
    preferences: CodexPreferences;
    onChange: (value: CodexPreferences) => void;
    effort?: EffortLevel | null;
    efforts: EffortLevel[];
    onEffortChange?: (value: EffortLevel) => void;
    serviceTiers?: string[];
};
export function CodexControls(_props: CodexControlsProps) { return null; }
