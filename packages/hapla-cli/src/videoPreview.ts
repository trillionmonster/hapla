#!/usr/bin/env node

import { WorkspaceVideoPreviewManager } from './modules/common/workspaceVideoPreview';

// Compatibility helper for a running older daemon. It deliberately does not
// import session startup, authentication, or daemon lifecycle code.
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const options = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (!['--root', '--path'].includes(key) || options.has(key) || typeof value !== 'string') {
            process.stdout.write(JSON.stringify({ success: false, error: 'Expected --root <workspace> --path <video>' }) + '\n');
            process.exitCode = 1;
            return;
        }
        options.set(key, value);
    }
    const root = options.get('--root');
    const path = options.get('--path');
    if (!root || !path) {
        process.stdout.write(JSON.stringify({ success: false, error: 'Expected --root <workspace> --path <video>' }) + '\n');
        process.exitCode = 1;
        return;
    }
    const result = await new WorkspaceVideoPreviewManager(root).getPreview(path);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.success) process.exitCode = 1;
}

void main().catch(() => {
    process.stdout.write(JSON.stringify({ success: false, error: 'Video preview is unavailable' }) + '\n');
    process.exitCode = 1;
});
