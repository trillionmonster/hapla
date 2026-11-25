import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { FloatingOverlayProps } from './FloatingOverlay';

/** Keep the anchored panel below the app header; long content scrolls inside it. */
export default function FloatingOverlayContent({ children, maxHeight = 240, accessibilityLabel, showScrollIndicator = false }: FloatingOverlayProps) {
    const { theme } = useUnistyles();
    const element = React.useRef<HTMLDivElement>(null);
    const [height, setHeight] = React.useState(maxHeight);
    React.useLayoutEffect(() => {
        const measure = () => {
            if (!element.current) return;
            const viewport = window.visualViewport;
            const top = (viewport?.offsetTop ?? 0) + 72;
            const bottom = element.current.getBoundingClientRect().bottom;
            setHeight(Math.max(48, Math.min(maxHeight, bottom - top, (viewport?.height ?? window.innerHeight) - 80)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element.current!);
        window.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('scroll', measure);
        return () => {
            observer.disconnect(); window.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('scroll', measure);
        };
    }, [maxHeight]);
    return <div ref={element} aria-label={accessibilityLabel} style={{ maxHeight: height, borderRadius: 12, overflow: 'hidden',
        background: theme.dark ? theme.colors.surfaceHigh : '#F1F4F8', border: `1px solid ${theme.dark ? theme.colors.modal.border : '#C8D1DC'}`,
        boxShadow: `0 8px 18px ${theme.dark ? 'rgba(0,0,0,.3)' : 'rgba(20,35,60,.12)'}` }}>
        <div style={{ maxHeight: height - 2, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: showScrollIndicator ? 'auto' : 'none' }}>{children}</div>
    </div>;
}
