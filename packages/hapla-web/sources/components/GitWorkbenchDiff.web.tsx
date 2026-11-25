import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReviewPatch } from './gitWorkbenchDiff';

const ROW_HEIGHT = 24;
const OVERSCAN = 12;

/** Fixed-height rows bound DOM cost independently of diff size. Raw view retains native find/copy. */
export function GitWorkbenchDiff({ text, patch, label, raw }: { text: string; patch: ReviewPatch; label: string; raw: boolean }) {
    const viewport = React.useRef<HTMLDivElement>(null);
    const [window, setWindow] = React.useState({ first: 0, count: 60 });
    const update = React.useCallback(() => {
        const node = viewport.current; if (!node) return;
        const first = Math.max(0, Math.floor(node.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const count = Math.ceil(node.clientHeight / ROW_HEIGHT) + 2 * OVERSCAN;
        setWindow(previous => previous.first === first && previous.count === count ? previous : { first, count });
    }, []);
    React.useEffect(() => {
        const node = viewport.current; if (!node) return;
        update(); const observer = new ResizeObserver(update); observer.observe(node);
        return () => observer.disconnect();
    }, [update, raw]);
    React.useEffect(() => { update(); }, [text, update]);
    if (raw) return <pre className="hapla-git-diff hapla-git-raw" aria-label={label} tabIndex={0}>{text}</pre>;
    const rows = patch.lines.slice(window.first, window.first + window.count);
    return <div ref={viewport} className="hapla-git-diff" role="region" aria-label={label} tabIndex={0} onScroll={update} data-total-lines={patch.lines.length}>
        <div className="hapla-git-diff-canvas" style={{ height: patch.lines.length * ROW_HEIGHT, minWidth: Math.max(340, patch.width * 7.85 + 126) }}>
            <div className="hapla-git-diff-window" style={{ transform: `translateY(${window.first * ROW_HEIGHT}px)` }}>
                {rows.map((line, index) => <div key={window.first + index} className={`hapla-git-line hapla-git-line--${line.kind}`}>
                    {line.kind === 'file' ? <><span className="hapla-git-diff-file-icon"><Ionicons name="document-text-outline" size={14} color="currentColor" /></span><span className="hapla-git-diff-filename">{line.text}</span></> : <>
                        <span className="hapla-git-line-number" aria-hidden="true">{line.oldLine}</span>
                        <span className="hapla-git-line-number" aria-hidden="true">{line.newLine}</span>
                        <span className="hapla-git-line-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span>
                        <span className="hapla-git-line-code">{line.text || ' '}</span>
                    </>}
                </div>)}
            </div>
        </div>
    </div>;
}
