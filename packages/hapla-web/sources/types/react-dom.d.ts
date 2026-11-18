declare module 'react-dom' {
    import type { ReactNode } from 'react';

    export function createPortal(
        children: ReactNode,
        container: Element | DocumentFragment,
        key?: string | null,
    ): ReactNode;
}

declare module 'react-dom/server' {
    import type { ReactNode } from 'react';
    export function renderToStaticMarkup(children: ReactNode): string;
}
