import { validatePreviewTarget } from '@hapla/wire';

/** Preserve the registered upstream base path without accepting another origin. */
export function previewTargetUrl(base: string, suffix: string): string {
    const url = new URL(validatePreviewTarget(base));
    const question = suffix.indexOf('?');
    let path = (question < 0 ? suffix : suffix.slice(0, question)).replace(/^\/+/, '');
    const basePath = url.pathname.replace(/\/$/, '');
    // Apps hosted below /app/ often emit absolute /app/assets URLs. Do not
    // prepend the configured base again when those resources return via Hapla.
    if (basePath && (`/${path}` === basePath || `/${path}`.startsWith(basePath + '/'))) path = path.slice(basePath.length).replace(/^\/+/, '');
    url.pathname = `${basePath}/${path}`;
    if (question >= 0) {
        if (!url.search) url.search = suffix.slice(question);
        else {
            const incoming = new URLSearchParams(suffix.slice(question));
            for (const key of new Set(incoming.keys())) url.searchParams.delete(key);
            for (const [key, value] of incoming) url.searchParams.append(key, value);
        }
    }
    return url.toString();
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
export function previewRequestHeaders(headers: Record<string, string | string[] | undefined>, allowAuthorization = false): Record<string, string | string[]> {
    const blocked = new Set([...HOP_HEADERS, ...(allowAuthorization ? [] : ['authorization']), ...String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || blocked.has(key.toLowerCase()) || key.toLowerCase().startsWith('x-hapla-') || key.toLowerCase().startsWith('sec-websocket-')) continue;
        if (key.toLowerCase() === 'cookie') {
            const cookies = String(value).split(';').filter(cookie => !cookie.trim().startsWith('hapla_')).join(';');
            if (cookies.trim()) result.cookie = cookies;
        } else result[key] = value;
    }
    return result;
}

/** Browser addresses always derive from location; only the upstream origin is registered. */
export function previewHtmlBridge(prefix: string, target: string): string {
    const settings = JSON.stringify({ prefix, upstream: new URL(target).origin }).replace(/</g, '\\u003c');
    return `<script>(function(){const cfg=${settings};const origin=location.origin;function route(value,ws){try{const u=new URL(String(value),location.href);const own=u.origin.replace(/^ws/,"http");if((own===origin||own===cfg.upstream)&&!u.pathname.startsWith(cfg.prefix)){u.protocol=ws?(location.protocol==="https:"?"wss:":"ws:"):location.protocol;u.host=location.host;u.pathname=cfg.prefix+u.pathname.replace(/^\\/+/,"");}return u.href}catch(e){return value}}const fetch0=window.fetch;window.fetch=function(input,init){if(input instanceof Request){const mapped=route(input.url);return fetch0.call(this,mapped===input.url?input:new Request(mapped,input),init)}return fetch0.call(this,route(input),init)};const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){const args=Array.from(arguments);args[1]=route(url);return open.apply(this,args)};for(const name of ["WebSocket","EventSource","Worker","SharedWorker"]){const Original=window[name];if(!Original)continue;const Wrapped=function(url,options){return Reflect.construct(Original,[route(url,name==="WebSocket"),options],Original)};Object.setPrototypeOf(Wrapped,Original);Wrapped.prototype=Original.prototype;window[name]=Wrapped;}for(const method of ["pushState","replaceState"]){const original=history[method];history[method]=function(state,title,url){return original.call(this,state,title,url==null?url:route(url))}}})();</script>`;
}

export function previewResponseHeaders(headers: Record<string, string | string[] | undefined>, handle: string, target: string): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_HEADERS.has(name.toLowerCase())) continue;
        if (name.toLowerCase() === 'set-cookie') {
            result[name] = (Array.isArray(value) ? value : [value]).map(cookie => cookie.replace(/;\s*(?:domain|path)=[^;]*/gi, '') + `; Path=/preview/${handle}/`);
        } else if (name.toLowerCase() === 'location' && typeof value === 'string') {
            const destination = new URL(value, target);
            result[name] = destination.origin === new URL(target).origin ? `/preview/${handle}${destination.pathname}${destination.search}${destination.hash}` : value;
        } else result[name] = value;
    }
    // A response belongs to one authenticated account even after intermediate proxies.
    result['cache-control'] = 'private, no-store';
    result['referrer-policy'] = 'same-origin';
    return result;
}
