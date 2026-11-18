/** Isolation fixture: actual Sync, Zustand store, reducer, page planner and cache; synthetic HTTP history, transport decryption and platform services. */
import { storage } from '../../../packages/hapla-web/sources/sync/storage';
import { sync } from '../../../packages/hapla-web/sources/sync/sync';
import { EncryptionCache } from '../../../packages/hapla-web/sources/sync/encryption/encryptionCache';
import { sessionResources, estimateRetainedBytes } from '../../../packages/hapla-web/sources/sync/sessionResources';
import type { Session } from '../../../packages/hapla-web/sources/sync/storageTypes';

const cache = new EncryptionCache();
const ciphers = new Map();
(sync as any).encryption = {
    getSessionEncryption(id: string) {
        if (!ciphers.has(id)) ciphers.set(id, {
            async decryptMessages(messages: any[]) {
                return messages.map((message) => { cache.setCachedMessage(message.id, message, id); return message; });
            },
        });
        return ciphers.get(id);
    },
    clearSessionCache(id: string) { cache.clearSessionCache(id); },
};
// This fixture supplies lightweight session metadata directly; message synchronization stays real.
(sync as any).sessionsSync = { invalidate() {}, stop() {} };
let release: (() => void) | undefined;
let current: string | undefined;
let opened = 0;
let blobCount = 0;
let aborted = 0;
let maximumRows = 0;
let maximumEvents = 0;
let cursorEvidence: unknown = null;
let sleepingHistoryLoaded = false;
let busy = false;
const ids = Array.from({ length: 50 }, (_, index) => `fixture-${index}`);
const runtimes = ['runtime-new', 'runtime-middle', 'runtime-old'];
storage.getState().applySessions([...ids, ...runtimes, 'fixture-abort'].map((id, index) => ({
    id, presence: 0, createdAt: index, updatedAt: 1, seq: 100000, active: false, activeAt: 1,
    thinking: false, thinkingAt: 1, metadataVersion: 1, metadata: { name: id, path: '/fixture', host: 'fixture' },
    agentStateVersion: 1, agentState: {},
} as Session)));

const rows = document.querySelector('#rows')!;
function render() {
    const messages = current ? storage.getState().sessionMessages[current]?.messages ?? [] : [];
    rows.replaceChildren(...messages.slice(0, 12).map((message) => {
        const node = document.createElement('p'); node.dataset.messageId = message.id;
        node.textContent = 'text' in message ? message.text.slice(0, 180) : message.kind;
        return node;
    }));
    maximumRows = Math.max(maximumRows, rows.children.length);
    maximumEvents = Math.max(maximumEvents, ...Object.values(storage.getState().sessionMessages).map((page) => page.cachedEventCount ?? 0));
    document.querySelector('#status')!.textContent = current ? `${current} · loaded ${messages.length} rows · ${opened} switches` : `No session body retained · ${opened} switches`;
}
const unsubscribe = storage.subscribe(render);
const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error('fixture wait timeout'); await new Promise((resolve) => setTimeout(resolve, 5)); }
};
async function leave() {
    release?.(); release = undefined; current = undefined;
    await Promise.resolve(); render();
}
async function open(id: string) {
    await leave(); current = id;
    release = sync.retainVisibleSessions([id]);
    await wait(() => !!storage.getState().sessionMessages[id]?.isLoaded);
    const controller = new AbortController();
    sessionResources.register(id, () => { controller.abort(); aborted++; });
    const objectUrl = URL.createObjectURL(new Blob(['x'.repeat(500000)], { type: 'text/plain' }));
    blobCount++;
    sessionResources.trackObjectUrl(id, objectUrl);
    sessionResources.register(id, () => blobCount--);
    const page = storage.getState().sessionMessages[id];
    const raw = Object.values(page.rawMessagesMap ?? {})[20];
    storage.getState().saveSessionScrollAnchor(id, { sourceSessionId: id, messageId: raw?.id, seq: raw?.seq, offset: 600 });
    storage.getState().applySessionStream(id, { id: `stream-${id}`, turnId: 'turn', text: 'live preview'.repeat(1000), updatedAt: 1 });
    storage.getState().applyFileCache(id, '/fixture.txt', 'file preview'.repeat(20000), null, false);
    opened++; render();
}
async function history() {
    await leave();
    current = runtimes[0]; release = sync.retainVisibleSessions(runtimes);
    await wait(() => !!storage.getState().sessionMessages[current!]?.isLoaded);
    const initialRuntimes = Object.keys(storage.getState().sessionMessages);
    const initialCount = storage.getState().sessionMessages[current].cachedEventCount;
    // Simulate a 100k-event reconnect gap using the actual sync catchup path.
    (sync as any).sessionLastSeq.set(current, 1);
    await (sync as any).fetchMessages(current);
    const catchupCount = storage.getState().sessionMessages[current].cachedEventCount;
    const page = storage.getState().sessionMessages[current];
    const raw = Object.values(page.rawMessagesMap ?? {})[30];
    storage.getState().saveSessionScrollAnchor(current, { sourceSessionId: current, seq: raw?.seq, messageId: raw?.id, offset: 700 });
    const savedSeq = raw?.seq;
    await leave();
    current = runtimes[0]; release = sync.retainVisibleSessions(runtimes);
    await wait(() => !!storage.getState().sessionMessages[current!]?.isLoaded);
    const restored = Object.values(storage.getState().sessionMessages[current].rawMessagesMap ?? {}).some((message) => message.seq === savedSeq);
    // An older runtime is requested only after the current runtime reaches its beginning.
    // Set this cursor boundary directly, rather than fetch all 100k fixture events.
    storage.getState().applyMessagePageState(current, { hasOlder: false });
    await sync.loadOlderConversationMessages(runtimes);
    current = runtimes[1];
    const archivedResident = Object.keys(storage.getState().sessionMessages);
    const archivedRaw = Object.values(storage.getState().sessionMessages[current].rawMessagesMap ?? {})[25];
    storage.getState().saveSessionScrollAnchor(runtimes[0], { sourceSessionId: current, seq: archivedRaw?.seq, messageId: archivedRaw?.id, offset: 700 });
    await leave();
    current = runtimes[1]; release = sync.retainVisibleSessions(runtimes);
    await wait(() => !!storage.getState().sessionMessages[current!]?.isLoaded);
    const archivedRestored = Object.keys(storage.getState().sessionMessages).join() === current
        && Object.values(storage.getState().sessionMessages[current].rawMessagesMap ?? {}).some((message) => message.seq === archivedRaw?.seq);
    await sync.returnToLatestConversationMessages(runtimes);
    current = runtimes[0];
    const latestResident = Object.keys(storage.getState().sessionMessages);
    cursorEvidence = { initialRuntimes, initialCount, catchupCount, restored, archivedRestored, savedSeq, archivedResident, latestResident, boundaryWasInjected: true };
    await leave();
}
async function sleepingHistory() {
    await leave();
    const id = 'fixture-sleeping-history';
    // The first server snapshot can describe a sleeping runtime. Reading it
    // must still load its own history, even if a sibling has an empty page.
    (sync as any).applySessions([{ ...storage.getState().sessions[runtimes[0]], id,
        metadata: { name: id, path: '/fixture', host: 'fixture', lifecycleState: 'sleeping', activeCodexBranchId: 'original' },
    }]);
    storage.getState().applyMessagePageState(runtimes[0], { hasOlder: false });
    current = id; release = sync.retainVisibleSessions([id, runtimes[0]]);
    await wait(() => !!storage.getState().sessionMessages[id]?.isLoaded);
    sleepingHistoryLoaded = storage.getState().sessionMessages[id].cachedEventCount === 80;
    await leave();
}
async function abortProbe() {
    await leave(); current = 'fixture-abort'; release = sync.retainVisibleSessions([current]);
    await wait(() => sessionResources.getStats().resources >= 2);
    await leave();
    await wait(() => (window as any).fixtureRequestAborts >= 1);
}
function stats() {
    const state = storage.getState();
    return {
        opened, current: current ?? null, busy, requestAborts: (window as any).fixtureRequestAborts ?? 0, maximumRows, maximumEvents, blobCount, aborted, sleepingHistoryLoaded,
        bodySessions: Object.keys(state.sessionMessages), streamSessions: Object.keys(state.sessionStreams),
        fileSessions: Object.keys(state.sessionFileCache), resources: sessionResources.getStats(),
        retainedBodyBytes: estimateRetainedBytes([state.sessionMessages, state.sessionStreams, state.sessionFileCache]),
        decryption: cache.getStats(), syncMaps: {
            messageSync: (sync as any).messagesSync.size, queue: (sync as any).sessionMessageQueue.size,
            cursors: (sync as any).sessionLastSeq.size, locks: (sync as any).sessionMessageLocks.size,
        }, cursorEvidence,
    };
}
async function run(action: () => Promise<void>) {
    busy = true;
    try { await action(); } catch (error) { (window as any).fixtureError = String(error); throw error; }
    finally { busy = false; }
}
document.querySelector('#next')!.addEventListener('click', () => void run(() => open(ids[opened % 50])));
document.querySelector('#leave')!.addEventListener('click', () => void run(leave));
(window as any).fixture = { stats, history: () => run(history), sleepingHistory: () => run(sleepingHistory), abortProbe: () => run(abortProbe), leave, open, dispose: () => { unsubscribe(); void leave(); } };
render();
