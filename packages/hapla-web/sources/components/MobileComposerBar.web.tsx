import * as React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { apiSocket } from '@/sync/apiSocket';
import { useCodexFollowupStyle } from './codexFollowupStyle';
import type { MobileComposerBarProps } from './MobileComposerBar';
import './codexFollowups.css';

export function MobileComposerBar(props: MobileComposerBarProps) {
    const style = useCodexFollowupStyle();
    const root = React.useRef<HTMLDivElement>(null);
    const trigger = React.useRef<HTMLButtonElement>(null);
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState('');
    const [forking, setForking] = React.useState(false);
    const [recentSend, setRecentSend] = React.useState(false);
    React.useEffect(() => {
        if (!props.hasContent) {
            const timer = setTimeout(() => setRecentSend(false), 700);
            return () => clearTimeout(timer);
        }
    }, [props.hasContent]);
    const showStop = !!props.onAbort && !props.hasContent && !props.sending && !recentSend;
    React.useLayoutEffect(() => {
        if (open) root.current?.querySelector<HTMLElement>('[role="menu"] button')?.focus();
    }, [open]);
    React.useEffect(() => {
        if (!open) return;
        const outside = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                setOpen(false);
                trigger.current?.focus();
            }
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape, true);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', escape, true);
        };
    }, [open]);
    const action = (callback: () => void) => {
        setOpen(false);
        setError('');
        callback();
    };
    const item = (
        label: string,
        name: React.ComponentProps<typeof Ionicons>['name'],
        callback?: () => void,
        text = label,
    ) =>
        callback && (
            <button type="button" role="menuitem" aria-label={label} onClick={() => action(callback)}>
                <Ionicons name={name} size={17} color="currentColor" aria-hidden />
                <span>{text}</span>
            </button>
        );
    const fork = async () => {
        setForking(true);
        setError('');
        try {
            await apiSocket.sessionCommand(props.sessionId!, 'codex-thread-fork-current', {});
            setOpen(false);
        } catch (problem) {
            setError(problem instanceof Error ? problem.message : '创建分支失败，请重试');
        } finally {
            setForking(false);
        }
    };
    const menuKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        ]?.focus();
    };
    return (
        <div className="hapla-mobile-composer-bar" style={style}>
            <div ref={root} className="hapla-mobile-composer-more">
                <button
                    ref={trigger}
                    type="button"
                    className="hapla-mobile-composer-tool"
                    aria-label="更多输入操作"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => setOpen((value) => !value)}
                >
                    <Ionicons name="ellipsis-horizontal" size={21} color="currentColor" aria-hidden />
                </button>
                {open && (
                    <div
                        role="menu"
                        aria-label="输入操作"
                        className="hapla-mobile-composer-menu"
                        onKeyDown={menuKeys}
                    >
                        {item('当前会话全部历史问题', 'time-outline', props.onHistory, '历史问题')}
                        {item('Open session settings', 'options-outline', props.onSettings, '会话设置')}
                        {item('添加附件', 'attach-outline', props.onFiles)}
                        {item('Attach image', 'image-outline', props.onImages, '添加图片')}
                        {item('工作区状态', 'git-branch-outline', props.onWorkspace)}
                        {props.sessionId && props.controls && (
                            <button
                                type="button"
                                role="menuitem"
                                aria-label="新分支"
                                disabled={forking}
                                onClick={() => void fork()}
                            >
                                <Ionicons
                                    name="git-branch-outline"
                                    size={17}
                                    color="currentColor"
                                    aria-hidden
                                />
                                <span>{forking ? '正在创建…' : '新分支'}</span>
                            </button>
                        )}
                        {props.onAbort && props.hasContent && (
                            <button
                                type="button"
                                role="menuitem"
                                className="is-danger"
                                aria-label="停止当前任务"
                                disabled={props.aborting}
                                onClick={() => action(() => void props.onAbort?.())}
                            >
                                <Ionicons name="stop-outline" size={17} color="currentColor" aria-hidden />
                                <span>停止主任务</span>
                            </button>
                        )}
                        {error && (
                            <div role="alert" className="hapla-followup-error">
                                {error}
                            </div>
                        )}
                    </div>
                )}
            </div>
            <div className="hapla-mobile-composer-controls">{props.controls}</div>
            <button
                type="button"
                className={`hapla-mobile-composer-primary${showStop ? ' is-stop' : ''}`}
                aria-label={showStop ? '停止当前任务' : props.sending ? 'Sending message' : 'Send message'}
                disabled={showStop ? props.aborting : !props.canSend}
                onClick={() => {
                    if (showStop) void props.onAbort?.();
                    else {
                        setRecentSend(true);
                        props.onSend();
                    }
                }}
            >
                {props.sending || (showStop && props.aborting) ? (
                    <span className="hapla-mobile-composer-spinner" />
                ) : showStop ? (
                    <>
                        <Ionicons name="stop" size={11} color="currentColor" aria-hidden />
                        <span>停止主任务</span>
                    </>
                ) : (
                    <Ionicons name="arrow-up" size={20} color="currentColor" aria-hidden />
                )}
            </button>
            {props.status && (
                <span className="hapla-composer-sr-only" role="status">
                    {props.status}
                </span>
            )}
        </div>
    );
}
