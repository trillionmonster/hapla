import { useUnistyles } from 'react-native-unistyles';
import * as React from 'react';

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#10151b;color:#e9f0f6;font:15px/1.55 system-ui;padding:18px}main{max-width:720px;margin:auto}h2{margin:0 0 8px}p{margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:12px}.card{border:1px solid #344250;border-radius:10px;padding:13px;background:#18212a}button{min-height:44px;border:0;border-radius:9px;padding:0 14px;background:#74d3b5;color:#0b251d;font-weight:700}</style>
</head><body><main><h2>Sandbox HTML 验收</h2><button id="verify">验证隔离内交互</button><p style="margin-top:12px">这个页面实际运行在 iframe 中；布局会随宽度折行，脚本只能修改 iframe 内部。</p><div class="grid"><div class="card">窄屏自动单列</div><div class="card">宽屏自动分栏</div><div class="card" id="state">脚本尚未执行</div></div></main><script>const verify=()=>{document.querySelector('#state').textContent='iframe 内交互正常 ✓';parent.postMessage({source:'hapla-html-acceptance',status:'iframe 内交互正常 ✓'},'*')};document.querySelector('#verify').onclick=verify;addEventListener('message',event=>{if(event.data?.source==='hapla-host-acceptance'&&event.data?.command==='verify')verify()});</script></body></html>`;

export function HtmlAcceptanceDemo() {
    const { theme } = useUnistyles();
    const frameRef = React.useRef<HTMLIFrameElement | null>(null);
    const [status, setStatus] = React.useState('等待验证 iframe 内交互');
    React.useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.source !== frameRef.current?.contentWindow || event.data?.source !== 'hapla-html-acceptance') return;
            setStatus(String(event.data.status || 'iframe 内交互已响应'));
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, []);
    return <><iframe ref={frameRef} title="HTML 沙箱展示验收" srcDoc={html} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ display: 'block', width: '100%', height: 330, border: '1px solid #344250', borderRadius: 12, background: '#10151b' }} /><div role="status" aria-live="polite" style={{ marginTop: 8, fontSize: theme.typography.caption.fontSize }}>{status}</div></>;
}
