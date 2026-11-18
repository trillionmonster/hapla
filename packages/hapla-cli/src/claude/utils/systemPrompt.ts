import { trimIdent } from "@/utils/trimIdent";

/**
 * Base system prompt shared across all configurations
 */
export const systemPrompt = (() => trimIdent(`
    When a chat starts, call "mcp__hapla__change_title" with a concise title. Update the title again only when the task changes materially.
`))();
