/** Read-only, authenticated machine navigation; never exposes file contents. */
export interface MachineDirectoryRequest {
    path: string;
    mode?: 'list' | 'check';
    showHidden?: boolean;
    offset?: number;
}

export interface MachineDirectoryEntry {
    name: string;
    path: string;
    type: 'directory' | 'file' | 'other';
    symlink: boolean;
}

export type MachineDirectoryResponse = {
    success: true;
    kind: 'directory' | 'missing';
    path: string;
    parentPath: string | null;
    homePath: string;
    entries: MachineDirectoryEntry[];
    total: number;
    nextOffset: number | null;
} | {
    success: false;
    code: 'invalid_path' | 'not_directory' | 'permission_denied' | 'unavailable';
    error: string;
};
