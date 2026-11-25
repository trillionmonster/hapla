import * as React from 'react';
import type { FloatingOverlayProps } from './FloatingOverlay';
export type { FloatingOverlayProps } from './FloatingOverlay';
const Content = React.lazy(() => import('./FloatingOverlayContent.web'));
export function FloatingOverlay(props: FloatingOverlayProps) {
    return <React.Suspense fallback={null}><Content {...props} /></React.Suspense>;
}
