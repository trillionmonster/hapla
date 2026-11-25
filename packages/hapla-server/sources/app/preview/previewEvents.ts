import { EventEmitter } from 'node:events';
/** One relay owns a registration's live tunnels. Never include credentials. */
export const previewEvents = new EventEmitter();
export function previewChanged(handle: string) { previewEvents.emit('changed', handle); }
