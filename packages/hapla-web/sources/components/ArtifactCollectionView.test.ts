import * as React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactCollection, ArtifactItem } from './artifactTimeline';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1280 }),
    View: ({ children, dataSet }: any) => React.createElement('div', { dataSet }, children),
    Pressable: ({ children, accessibilityLabel, accessibilityState, onPress, disabled }: any) =>
        React.createElement('button', { 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, onClick: onPress, disabled }, children),
}));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({ useUnistyles: () => ({ theme: { typography,  colors: { text: '#fff', textSecondary: '#aaa', divider: '#333', surface: '#222', surfaceHigh: '#333' } } }) }); });
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('./StyledText', () => ({ Text: ({ children }: any) => React.createElement('span', null, children) }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
import { ArtifactCollectionView } from './ArtifactCollectionView';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function collection(origin: ArtifactCollection['origin'], count: number): ArtifactCollection {
    return { key: 'collection', scope: 'scope', origin, rows: [], items: Array.from({ length: count }, (_, i) =>
        ({ key: `item-${i}`, name: `clip-${i}.mp4`, path: `/work/clip-${i}.mp4`, kind: 'video' } as ArtifactItem)) };
}

describe('artifact collection mounting budget', () => {
    it('mounts no automatic previews until opened, replaces six-item pages, and unloads all previews on collapse', async () => {
        const alive = new Set<string>();
        function Preview({ item }: { item: ArtifactItem }) {
            React.useEffect(() => { alive.add(item.key); return () => { alive.delete(item.key); }; }, [item.key]);
            return React.createElement('article', { 'data-preview': item.key });
        }
        const before = vi.fn();
        const renderItem = (item: ArtifactItem) => React.createElement(Preview, { item });
        let root: any;
        await act(async () => { root = create(React.createElement(ArtifactCollectionView, { collection: collection('automatic', 30), renderItem, onBeforeChange: before })); });
        const press = async (label: string) => act(async () => root.root.findByProps({ 'aria-label': label }).props.onClick());
        expect(alive.size).toBe(0);
        expect(root.root.findAllByType('article')).toHaveLength(0);
        await press('展开过程文件');
        expect([...alive]).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
        await press('下一页附件');
        expect([...alive]).toEqual(['item-6', 'item-7', 'item-8', 'item-9', 'item-10', 'item-11']);
        expect(root.root.findAllByType('article')).toHaveLength(6);
        await press('收起过程文件');
        expect(alive.size).toBe(0);
        expect(before).toHaveBeenCalledTimes(3);
        await act(async () => root.unmount());
    });

    it.each(['reference', 'legacy'] as const)('opens a small %s collection and does not suddenly collapse as streamed items arrive', async origin => {
        const renderItem = (item: ArtifactItem) => React.createElement('article', { 'data-preview': item.key });
        let root: any;
        await act(async () => { root = create(React.createElement(ArtifactCollectionView, { collection: collection(origin, 2), renderItem })); });
        expect(root.root.findAllByType('article')).toHaveLength(2);
        await act(async () => root.update(React.createElement(ArtifactCollectionView, { collection: collection(origin, 30), renderItem })));
        expect(root.root.findAllByType('article')).toHaveLength(6);
        expect(root.root.findByProps({ 'aria-label': '下一页附件' })).toBeDefined();
        await act(async () => root.unmount());
    });

    it('starts an already large reference collection collapsed', async () => {
        const renderItem = vi.fn(() => React.createElement('article'));
        let root: any;
        await act(async () => { root = create(React.createElement(ArtifactCollectionView, { collection: collection('reference', 20), renderItem })); });
        expect(renderItem).not.toHaveBeenCalled();
        await act(async () => root.unmount());
    });

    it('does not expose signed query parameters in a collapsed legacy collection summary', async () => {
        const signed = 'https://cdn.example.test/final%20cut.mp4?X-Amz-Signature=TOKEN_DO_NOT_DISPLAY&expires=12';
        const value = collection('legacy', 4);
        value.items[0] = { ...value.items[0], path: signed, name: signed };
        value.items[1] = { ...value.items[1], path: signed + '&variant=2', name: 'final%20cut.mp4?X-Amz-Signature=TOKEN_DO_NOT_DISPLAY' };
        const renderItem = vi.fn(() => React.createElement('article'));
        let root: any;
        await act(async () => { root = create(React.createElement(ArtifactCollectionView, { collection: value, renderItem })); });
        const rendered = JSON.stringify(root.toJSON());
        expect(rendered).toContain('final cut.mp4');
        expect(rendered).not.toContain('X-Amz-Signature');
        expect(rendered).not.toContain('TOKEN_DO_NOT_DISPLAY');
        expect(renderItem).not.toHaveBeenCalled();
        expect(value.items[0].path).toBe(signed);
        expect(value.items[1].path).toBe(signed + '&variant=2');
        await act(async () => root.unmount());
    });
});
