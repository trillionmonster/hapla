import type { CodexFollowupMode } from '@hapla/wire';

export type ComposerDelivery = CodexFollowupMode | 'btw';
export const deliveryLabels: Record<ComposerDelivery, string> = {
    steer: '补充当前任务', queue: '排队下一轮', btw: '旁问 BTW', replace: '停止并发送',
};
export const deliveryHints: Record<ComposerDelivery, string> = {
    steer: '沿用当前执行设置补充指令；回复设置将在下一轮生效',
    queue: '当前任务结束后，再逐条处理',
    btw: '在独立旁聊中提问，主任务继续运行',
    replace: '明确停止当前任务，再处理新消息',
};
export type CodexFollowupControlsProps = {
    embedded?: boolean;
    sessionId: string;
    mode: ComposerDelivery;
    onMode: (mode: ComposerDelivery) => void;
    sideChatId?: string;
    onSideChat: (id?: string) => void;
    onSidePanel?: () => void;
    sidePanelOpen?: boolean;
};
