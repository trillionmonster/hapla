import type { ToolCall } from '@/sync/typesMessage';

function hasInteractiveApp(tool: ToolCall): boolean {
    const app = tool.input?.__haplaMcpApp ?? tool.result?.__haplaMcpApp;
    return !!(
        app
        && typeof app === 'object'
        && typeof app.resourceUri === 'string'
        && app.resourceUri.length > 0
    );
}

/**
 * Normal mode hides implementation details, not user-facing experiences.
 * Media generation and embedded Skill apps remain visible and interactive.
 */
export function shouldShowToolInNormalMode(tool: ToolCall | null | undefined): boolean {
    if (!tool) return false;
    return tool.permission?.status === 'pending'
        || tool.permission?.status === 'submitting'
        || tool.name === 'AskUserQuestion'
        || tool.name === 'file'
        || tool.name === 'CodexImageGeneration'
        || tool.name === 'CodexImageGenerationError'
        || hasInteractiveApp(tool);
}
