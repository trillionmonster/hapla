import * as React from 'react';
import { Message, ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
};

type ToolViewComponent = React.LazyExoticComponent<React.ComponentType<ToolViewProps>>;
type ToolLoader = () => Promise<{ default: React.ComponentType<ToolViewProps> }>;

const lazyNamed = (
    loader: () => Promise<Record<string, unknown>>,
    exportName: string,
): [ToolViewComponent, ToolLoader] => {
    const normalized: ToolLoader = async () => {
        const module = await loader();
        return { default: module[exportName] as React.ComponentType<ToolViewProps> };
    };
    return [React.lazy(normalized), normalized];
};

const [EditView, loadEditView] = lazyNamed(() => import('./EditView'), 'EditView');
const [BashView, loadBashView] = lazyNamed(() => import('./BashView'), 'BashView');
const [CodexBashView, loadCodexBashView] = lazyNamed(() => import('./CodexBashView'), 'CodexBashView');
const [CodexPatchView, loadCodexPatchView] = lazyNamed(() => import('./CodexPatchView'), 'CodexPatchView');
const [CodexDiffView, loadCodexDiffView] = lazyNamed(() => import('./CodexDiffView'), 'CodexDiffView');
const [WriteView, loadWriteView] = lazyNamed(() => import('./WriteView'), 'WriteView');
const [TodoView, loadTodoView] = lazyNamed(() => import('./TodoView'), 'TodoView');
const [ExitPlanToolView, loadExitPlanToolView] = lazyNamed(() => import('./ExitPlanToolView'), 'ExitPlanToolView');
const [MultiEditView, loadMultiEditView] = lazyNamed(() => import('./MultiEditView'), 'MultiEditView');
const [TaskView, loadTaskView] = lazyNamed(() => import('./TaskView'), 'TaskView');
const [AskUserQuestionView, loadAskUserQuestionView] = lazyNamed(() => import('./AskUserQuestionView'), 'AskUserQuestionView');
const [BashViewFull, loadBashViewFull] = lazyNamed(() => import('./BashViewFull'), 'BashViewFull');
const [EditViewFull, loadEditViewFull] = lazyNamed(() => import('./EditViewFull'), 'EditViewFull');
const [MultiEditViewFull, loadMultiEditViewFull] = lazyNamed(() => import('./MultiEditViewFull'), 'MultiEditViewFull');
const [FileArtifactView, loadFileArtifactView] = lazyNamed(() => import('./FileArtifactView'), 'FileArtifactView');

const toolViewRegistry: Record<string, { component: ToolViewComponent; load: ToolLoader }> = {
    file: { component: FileArtifactView, load: loadFileArtifactView },
    Edit: { component: EditView, load: loadEditView },
    Bash: { component: BashView, load: loadBashView },
    CodexBash: { component: CodexBashView, load: loadCodexBashView },
    CodexPatch: { component: CodexPatchView, load: loadCodexPatchView },
    CodexDiff: { component: CodexDiffView, load: loadCodexDiffView },
    Write: { component: WriteView, load: loadWriteView },
    TodoWrite: { component: TodoView, load: loadTodoView },
    ExitPlanMode: { component: ExitPlanToolView, load: loadExitPlanToolView },
    exit_plan_mode: { component: ExitPlanToolView, load: loadExitPlanToolView },
    MultiEdit: { component: MultiEditView, load: loadMultiEditView },
    Task: { component: TaskView, load: loadTaskView },
    Agent: { component: TaskView, load: loadTaskView },
    AskUserQuestion: { component: AskUserQuestionView, load: loadAskUserQuestionView },
};

const toolFullViewRegistry: Record<string, { component: ToolViewComponent; load: ToolLoader }> = {
    Bash: { component: BashViewFull, load: loadBashViewFull },
    CodexBash: { component: CodexBashView, load: loadCodexBashView },
    Edit: { component: EditViewFull, load: loadEditViewFull },
    MultiEdit: { component: MultiEditViewFull, load: loadMultiEditViewFull },
    Task: { component: TaskView, load: loadTaskView },
    Agent: { component: TaskView, load: loadTaskView },
};

export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return toolViewRegistry[toolName]?.component ?? null;
}

export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return toolFullViewRegistry[toolName]?.component ?? null;
}

export function preloadToolView(toolName: string): Promise<unknown> | null {
    return toolViewRegistry[toolName]?.load() ?? null;
}

export function preloadCommonCoderViews(): Promise<unknown[]> {
    return Promise.all([
        loadBashView(),
        loadEditView(),
        loadCodexBashView(),
        loadCodexPatchView(),
    ]);
}
