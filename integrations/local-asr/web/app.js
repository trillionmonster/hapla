const $ = id => document.getElementById(id);
const settingsIds = ['deviceSelect','languageSelect','chunkSelect','silenceRange','vadRange','contextInput'];
let ws, audioContext, microphone, worklet, source, analyser, mutedOutput;
let recording = false, starting = false, stopping = false, manualStop = false;
let startGeneration = 0;
let animationId, stopTimeout, completed = [], waveformSamples, resolveFlush;
const canvas = $('waveform'), ctx = canvas.getContext('2d');

function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function timeLabel(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2,'0')}:${(value % 60).toString().padStart(2,'0')}`;
}
function setControls() {
  $('recordBtn').disabled = starting || stopping;
  $('recordBtn').classList.toggle('recording', recording);
  $('recordLabel').textContent = starting ? '连接中…' : stopping ? '正在定稿…' : recording ? '停止录音' : '开始录音';
  $('flushBtn').hidden = !recording;
  $('flushBtn').disabled = stopping;
  settingsIds.forEach(id => $(id).disabled = recording || starting || stopping);
  $('settingsHint').textContent = recording ? '停止录音后可调整设置。' : '录音前可调整设置。';
  document.body.classList.toggle('recording-shell',recording);
}
function actions() {
  const hasText = completed.length > 0;
  $('copyBtn').disabled = !hasText;
  $('downloadBtn').disabled = !hasText;
  $('clearBtn').disabled = recording || starting || stopping || !hasText;
}
function drawWave() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const scale = window.devicePixelRatio || 1;
  if (canvas.width !== width * scale || canvas.height !== height * scale) {
    canvas.width = width * scale; canvas.height = height * scale;
  }
  ctx.setTransform(scale,0,0,scale,0,0); ctx.clearRect(0,0,width,height);
  ctx.strokeStyle = '#c4d9ce'; ctx.lineWidth = 1;
  ctx.beginPath();ctx.moveTo(0,height/2);ctx.lineTo(width,height/2);ctx.stroke();
  if (analyser && recording) {
    analyser.getFloatTimeDomainData(waveformSamples);
    ctx.strokeStyle = '#087d64';ctx.lineWidth = 1.5;ctx.beginPath();
    for(let x=0;x<width;x++) {
      const index = Math.floor(x/width*waveformSamples.length);
      const y = height/2 + waveformSamples[index] * height * 1.7;
      x ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
    }
    ctx.stroke();
  }
  if (recording) animationId = requestAnimationFrame(drawWave);
}
function scrollTranscript() { const box=$('transcript'); box.scrollTop=box.scrollHeight; }
const haplaBridge = new URLSearchParams(location.hash.slice(1));
const haplaOrigin = haplaBridge.get('haplaOrigin');
const haplaChannel = haplaBridge.get('haplaChannel');
function sendToHapla(text, final, stopped = false) {
  if (!haplaOrigin || !haplaChannel || !window.opener) return;
  try {
    const origin = new URL(haplaOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== haplaOrigin) return;
    window.opener.postMessage({ type: 'hapla-asr', channel: haplaChannel, text, final, stopped }, haplaOrigin);
  } catch { /* Standalone dictation remains available. */ }
}
function addFinal(message) {
  $('partial').hidden = true;
  if (!message.text) return;
  sendToHapla(message.text, true);
  $('emptyState').hidden = true;
  completed.push({text:message.text,start:message.start,end:message.end,language:message.language});
  const row=document.createElement('div');row.className='segment';
  const stamp=document.createElement('span');stamp.className='segment-time';stamp.textContent=timeLabel(message.start);
  const text=document.createElement('p');text.textContent=message.text;
  row.append(stamp,text);$('segments').append(row);actions();scrollTranscript();
}
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const previous=$('deviceSelect').value;
  const devices=await navigator.mediaDevices.enumerateDevices();
  $('deviceSelect').replaceChildren(new Option('系统默认麦克风',''));
  devices.filter(d=>d.kind==='audioinput' && d.deviceId && d.deviceId !== 'default').forEach((d,i)=>
    $('deviceSelect').add(new Option(d.label || `麦克风 ${i+1}`,d.deviceId)));
  if ([...$('deviceSelect').options].some(o=>o.value===previous)) $('deviceSelect').value=previous;
}
function onMessage(event) {
  const message=JSON.parse(event.data);
  if(message.type==='partial') {
    sendToHapla(message.text || '', false);
    if(message.text) { $('emptyState').hidden=true;$('partial').hidden=false;$('partialText').textContent=message.text;scrollTranscript(); }
  } else if(message.type==='final') addFinal(message);
  else if(message.type==='speech_start') { $('voiceState').textContent='正在说话';$('voiceState').classList.add('speaking'); }
  else if(message.type==='speech_end') {
    $('voiceState').textContent='等待说话';$('voiceState').classList.remove('speaking');
    if(message.reason==='duration_limit') $('vadCaption').textContent='长句已分段，继续说话即可。';
  } else if(message.type==='vad') {
    $('timer').textContent=timeLabel(message.elapsed);
    $('silenceProgress').value=message.silence_ms;
    $('silenceText').textContent=`${message.silence_ms} / ${$('silenceRange').value} ms`;
    $('levelText').textContent=message.rms > 0.00001 ? `${Math.round(20*Math.log10(message.rms))} dB` : '−∞ dB';
    $('voiceState').textContent=message.speaking ? message.silence_ms ? '停顿中' : '正在说话' : '等待说话';
    $('voiceState').classList.toggle('speaking',message.speaking);
    $('vadCaption').textContent=`语音概率 ${Math.round(message.probability*100)}% · 连续静音后自动断句`;
  } else if(message.type==='stopped') { clearTimeout(stopTimeout); cleanup(); }
  else if(message.type==='error') { notice(message.message);cleanup(); }
  if(message.decode_ms != null) $('latency').textContent=`推理 ${message.decode_ms} ms`;
}
async function cleanup() {
  startGeneration++;
  recording=false;starting=false;stopping=false;
  clearTimeout(stopTimeout);
  cancelAnimationFrame(animationId);
  resolveFlush?.();resolveFlush=null;
  microphone?.getTracks().forEach(track=>track.stop());microphone=null;
  if(worklet) { worklet.port.onmessage=null;worklet.port.close(); }
  worklet?.disconnect();source?.disconnect();mutedOutput?.disconnect();
  worklet=null;source=null;analyser=null;mutedOutput=null;
  const oldAudio=audioContext;audioContext=null;
  if(ws) { const old=ws;ws=null;old.close(); }
  $('voiceState').textContent='待机';$('voiceState').classList.remove('speaking');
  $('silenceProgress').value=0;$('levelText').textContent='−∞ dB';
  setControls();actions();
  sendToHapla('',false,true);
  drawWave();
  if(oldAudio) await oldAudio.close().catch(()=>{});
}
function waitReady(socket,settings) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('模型连接超时，请检查服务。')),15000);
    socket.onopen=()=>socket.send(JSON.stringify(settings));
    socket.onerror=()=>{clearTimeout(timeout);reject(new Error('无法连接本机语音服务。'));};
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.type==='ready'){clearTimeout(timeout);socket.onmessage=onMessage;resolve();}
      else if(message.type==='error'){clearTimeout(timeout);reject(new Error(message.message));}
    };
    socket.onclose=()=>{clearTimeout(timeout);reject(new Error('语音服务连接已断开。'));};
  });
}
async function start() {
  if(starting || stopping || recording) return;
  if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice('麦克风需要安全连接。请使用本机 localhost 地址，或提供的 HTTPS 地址打开网页。');return;
  }
  notice();starting=true;manualStop=false;setControls();actions();
  const generation=++startGeneration;
  try {
    const settings={type:'start',sample_rate:16000,silence_ms:Number($('silenceRange').value),
      vad_threshold:Number($('vadRange').value),chunk_sec:Number($('chunkSelect').value),
      language:$('languageSelect').value || null,context:$('contextInput').value};
    audioContext=new AudioContext();
    await audioContext.resume();
    if(generation!==startGeneration) return;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,
      deviceId:$('deviceSelect').value ? {exact:$('deviceSelect').value} : undefined}});
    if(generation!==startGeneration) { stream.getTracks().forEach(track=>track.stop());return; }
    microphone=stream;
    await listDevices();
    if(generation!==startGeneration) return;
    ws=new WebSocket(`${location.protocol==='https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType='arraybuffer';
    await waitReady(ws,settings);
    if(generation!==startGeneration) return;
    await audioContext.audioWorklet.addModule('/static/pcm-worklet.js');
    if(generation!==startGeneration) return;
    analyser=audioContext.createAnalyser();analyser.fftSize=1024;waveformSamples=new Float32Array(1024);
    source=audioContext.createMediaStreamSource(microphone);
    worklet=new AudioWorkletNode(audioContext,'pcm-recorder');
    mutedOutput=audioContext.createGain();mutedOutput.gain.value=0;
    source.connect(analyser);source.connect(worklet);worklet.connect(mutedOutput);mutedOutput.connect(audioContext.destination);
    worklet.port.onmessage=({data})=>{
      if(data==='flushed'){resolveFlush?.();resolveFlush=null;return;}
      if(ws?.readyState===WebSocket.OPEN && (recording || stopping)) {
        if(ws.bufferedAmount>16000*2*8) { notice('音频发送积压，请停止后重新录音。');cleanup();return; }
        ws.send(data);
      }
    };
    ws.onclose=()=>{if(recording || stopping){if(!manualStop) notice('语音连接中断，已保留完成的文字。请重新开始录音。');cleanup();}};
    ws.onerror=()=>{notice('语音连接发生错误，请重新开始录音。');cleanup();};
    starting=false;recording=true;$('timer').textContent='00:00';$('voiceState').textContent='等待说话';
    setControls();actions();
    drawWave();
  } catch(error) {
    if(generation!==startGeneration) return;
    const permission=error.name==='NotAllowedError';
    notice(permission ? '麦克风权限被拒绝。请在浏览器地址栏允许使用麦克风后重试。' : error.name==='NotFoundError' ? '没有找到麦克风，请连接录音设备。' : error.message);
    await cleanup();
  }
}
async function stop() {
  if(!recording || stopping) return;
  stopping=true;manualStop=true;setControls();
  // The processor emits its remaining PCM before the stop control message.
  if(worklet) {
    await new Promise(resolve=>{
      const timeout=setTimeout(()=>{resolveFlush=null;resolve();},1000);
      resolveFlush=()=>{clearTimeout(timeout);resolve();};
      worklet.port.postMessage('flush');
    });
  }
  microphone?.getTracks().forEach(track=>track.stop());
  if(ws?.readyState===WebSocket.OPEN) {
    ws.send(JSON.stringify({type:'stop'}));
    stopTimeout=setTimeout(()=>{notice('定稿等待超时，已保留完成的文字。');cleanup();},30000);
  } else await cleanup();
}
$('recordBtn').onclick=()=>recording ? stop() : start();
window.addEventListener('message',event=>{
  if(!haplaOrigin || !haplaChannel || event.source!==window.opener || event.origin!==haplaOrigin
    || event.data?.type!=='hapla-asr-stop' || event.data.channel!==haplaChannel) return;
  if(recording) void stop();else void cleanup();
});
$('flushBtn').onclick=()=>{if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'flush'}));};
$('silenceRange').oninput=()=>{
  $('silenceValue').textContent=`${$('silenceRange').value} ms`;
  $('silenceText').textContent=`0 / ${$('silenceRange').value} ms`;
  $('silenceProgress').max=Number($('silenceRange').value);
};
$('vadRange').oninput=()=>{$('vadValue').textContent=Number($('vadRange').value).toFixed(2);};
$('clearBtn').onclick=()=>{completed=[];$('segments').replaceChildren();$('partial').hidden=true;$('partialText').textContent='';$('emptyState').hidden=false;actions();};
$('copyBtn').onclick=async()=>{
  try { await navigator.clipboard.writeText(completed.map(s=>s.text).join('\n'));$('copyBtn').textContent='已复制';setTimeout(()=>$('copyBtn').textContent='复制',1500); }
  catch { notice('复制失败，请选择转写文字后手动复制。'); }
};
$('downloadBtn').onclick=()=>{
  const blob=new Blob(['\ufeff'+completed.map(s=>`[${timeLabel(s.start)}] ${s.text}`).join('\n\n')],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;
  anchor.download=`听写-${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('beforeunload',()=>{microphone?.getTracks().forEach(track=>track.stop());ws?.close();});
navigator.mediaDevices?.addEventListener('devicechange',()=>listDevices().catch(()=>{}));
drawWave();listDevices().catch(()=>{});
async function checkHealth() {
  try {
    const response=await fetch('/api/health');if(!response.ok) throw new Error('服务尚未就绪');
    const health=await response.json();if(!health.ready) throw new Error('模型正在加载');
    $('serverStatus').classList.add('ready');$('serverStatus').lastChild.textContent=' 本地模型已就绪';
    setControls();
    if(!window.isSecureContext) notice('当前地址无法使用麦克风。请使用 localhost 或 HTTPS 地址。');
  } catch {
    $('serverStatus').classList.remove('ready');$('serverStatus').lastChild.textContent=' 等待本地模型';
    $('recordBtn').disabled=true;setTimeout(checkHealth,3000);
  }
}
checkHealth();
