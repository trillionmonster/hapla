import * as React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export function MathRenderer(props: { content: string; displayMode?: boolean }) {
    const html = React.useMemo(() => katex.renderToString(props.content, {
        displayMode: props.displayMode ?? false,
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
    }), [props.content, props.displayMode]);

    return React.createElement(props.displayMode ? 'div' : 'span', {
        role: 'math',
        'aria-label': props.content,
        style: props.displayMode ? { maxWidth: '100%', overflowX: 'auto', padding: '8px 0' } : undefined,
        dangerouslySetInnerHTML: { __html: html },
    });
}
