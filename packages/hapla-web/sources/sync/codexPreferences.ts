import { z } from 'zod';

export const CodexPreferencesSchema = z.object({
    verbosity: z.enum(['default', 'low', 'medium', 'high']).default('default'),
    serviceTier: z.string().max(64).default('default'),
    collaborationMode: z.enum(['default', 'plan']).default('default'),
});
export type CodexPreferences = z.infer<typeof CodexPreferencesSchema>;
export const defaultCodexPreferences: CodexPreferences = CodexPreferencesSchema.parse({});

export function resolveCodexServiceTier(serviceTier: string, supportedServiceTiers: readonly string[]): string {
    if (serviceTier === 'default' || serviceTier === 'standard' || supportedServiceTiers.includes(serviceTier)) return serviceTier;
    if (serviceTier === 'fast' || serviceTier === 'priority') {
        return supportedServiceTiers.find(tier => tier === 'fast' || tier === 'priority') ?? 'default';
    }
    return 'default';
}

export function codexPreferenceMeta(preferences?: CodexPreferences, supportedServiceTiers?: readonly string[]) {
    const serviceTier = supportedServiceTiers
        ? resolveCodexServiceTier(preferences?.serviceTier ?? 'default', supportedServiceTiers)
        : preferences?.serviceTier;
    return {
        verbosity: preferences?.verbosity && preferences.verbosity !== 'default' ? preferences.verbosity : null,
        serviceTier: serviceTier === 'standard' ? 'default' : serviceTier && serviceTier !== 'default' ? serviceTier : null,
        collaborationMode: preferences?.collaborationMode ?? 'default',
    };
}
