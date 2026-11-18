import { trimIdent } from './trimIdent';

export const CHANGE_TITLE_INSTRUCTION = trimIdent(
    'Based on this message, call mcp__hapla__change_title to change the chat session title so it represents the current task. If the task changes dramatically, call the tool again.',
);
