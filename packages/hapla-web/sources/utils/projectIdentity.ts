export const PROJECT_IDENTITY_ICONS = [
    'code-slash-outline',
    'cube-outline',
    'layers-outline',
    'construct-outline',
    'terminal-outline',
    'git-branch-outline',
    'hardware-chip-outline',
    'compass-outline',
    'extension-puzzle-outline',
    'color-palette-outline',
    'diamond-outline',
    'planet-outline',
    'grid-outline',
] as const;

const semanticIcons: ReadonlyArray<{ pattern: RegExp; icon: ProjectIdentityIconName }> = [
    { pattern: /demo|showcase|example/i, icon: 'sparkles-outline' },
    { pattern: /(?:^|[-_.\/])lab(?:$|[-_.\/])|experiment|research/i, icon: 'flask-outline' },
    { pattern: /server|backend|(?:^|[-_.\/])api(?:$|[-_.\/])/i, icon: 'server-outline' },
    { pattern: /frontend|(?:^|[-_.\/])web(?:$|[-_.\/])|website|dashboard/i, icon: 'browsers-outline' },
    { pattern: /video|audio|media|player/i, icon: 'play-circle-outline' },
    { pattern: /docs?|wiki|notes?/i, icon: 'document-text-outline' },
    { pattern: /mobile|android|(?:^|[-_.\/])ios(?:$|[-_.\/])/i, icon: 'phone-portrait-outline' },
    { pattern: /cloud|infra|deploy|worker/i, icon: 'cloud-outline' },
];

export type ProjectIdentityIconName =
    | typeof PROJECT_IDENTITY_ICONS[number]
    | 'sparkles-outline'
    | 'flask-outline'
    | 'server-outline'
    | 'browsers-outline'
    | 'play-circle-outline'
    | 'document-text-outline'
    | 'phone-portrait-outline'
    | 'cloud-outline';

export interface ProjectIdentity {
    icon: ProjectIdentityIconName;
    paletteIndex: number;
    label: string;
}

/**
 * Normalize a workspace directory without relying on the browser host OS.
 * Session metadata can contain either POSIX or Windows separators, so using
 * node:path here would make the same wire value behave differently per client.
 */
export function normalizeProjectPath(path: string | null | undefined): string | null {
    const rawPath = path?.trim();
    if (!rawPath) return null;

    const slashPath = rawPath.replace(/\\/g, '/');
    const isUncPath = slashPath.startsWith('//');
    let normalized = slashPath.replace(/\/{2,}/g, '/');
    if (isUncPath) normalized = `/${normalized}`;

    const isRoot = normalized === '/' || normalized === '//';
    const isWindowsDriveRoot = /^[a-z]:\/$/i.test(normalized);
    if (!isRoot && !isWindowsDriveRoot) normalized = normalized.replace(/\/+$/, '');

    return normalized || null;
}

/** Stable case-insensitive key used by the visual project identity. */
export function projectIdentityKey(path: string | null | undefined, fallback = 'Project'): string {
    const fallbackKey = fallback.trim() || 'Project';
    return (normalizeProjectPath(path) ?? fallbackKey).toLowerCase();
}

function stableHash(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function projectLabel(path: string | null | undefined, fallback = 'Project'): string {
    const normalized = normalizeProjectPath(path);
    const segments = normalized?.split('/').filter(Boolean);
    return segments?.at(-1) || fallback;
}

export function getProjectIdentity(path: string | null | undefined, fallback = 'Project'): ProjectIdentity {
    const label = projectLabel(path, fallback);
    const identityKey = projectIdentityKey(path, label);
    const hash = stableHash(identityKey);
    const semantic = semanticIcons.find(({ pattern }) => pattern.test(identityKey));

    return {
        icon: semantic?.icon || PROJECT_IDENTITY_ICONS[hash % PROJECT_IDENTITY_ICONS.length],
        paletteIndex: (hash >>> 8) % 8,
        label,
    };
}
