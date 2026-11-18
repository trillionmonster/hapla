#!/usr/bin/env python3
"""Encode a web-smoke CDP screencast preserving its recorded wall-clock timing."""
import argparse, json, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('evidence',type=Path);p.add_argument('output',type=Path);p.add_argument('--ffmpeg',default='ffmpeg');a=p.parse_args()
frames=json.loads(a.evidence.read_text()).get('screencastFrames',[])
if not frames: raise SystemExit('No recorded browser frames in evidence')
a.output.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hapla-recording-') as work:
 lines=[]
 for i,frame in enumerate(frames):
  image=Path(frame['path']).resolve()
  if not image.is_file():raise SystemExit('Missing recorded frame: '+str(image))
  duration=max(.001,frames[i+1]['timestamp']-frame['timestamp']) if i+1<len(frames) else .2
  escaped=str(image).replace("'", "'\\''")
  lines += ["file '"+escaped+"'",'duration '+str(duration)]
 lines.append(lines[-2]);manifest=Path(work)/'frames.txt';manifest.write_text('\n'.join(lines)+'\n')
 subprocess.run([a.ffmpeg,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(manifest),'-vsync','vfr','-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-preset','fast','-crf','25','-pix_fmt','yuv420p','-movflags','+faststart',str(a.output)],check=True)
print(json.dumps({'output':str(a.output),'frames':len(frames),'recordedSeconds':frames[-1]['timestamp']-frames[0]['timestamp']},ensure_ascii=False))
