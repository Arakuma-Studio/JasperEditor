import { runRotoJob } from '/var/lib/orquester/workspaces/jaspersito/JasperEditor/.claude/worktrees/roto/apps/engine/src/roto/worker/run.ts';
import { decodeGreyPng } from '/var/lib/orquester/workspaces/jaspersito/JasperEditor/.claude/worktrees/roto/apps/engine/src/roto/core/codec.ts';
import { readFileSync, rmSync } from 'node:fs';
const engine = process.argv[2] as 'model'|'classic';
const store='/tmp/roto-work/store-'+engine; rmSync(store,{recursive:true,force:true});
const spec:any = { store, jobId:'t', ffmpeg:'ffmpeg', file:'/tmp/roto-work/fx/disk.mp4', mediaKey:'m', display:{width:640,height:360}, rate:{num:30,den:1}, still:false, frameCount:30,
 roto:{kind:'brush', base:10, span:[0,29], strokes:[{kind:'fg',frame:10,radius:8,points:[[250,200],[270,200]]}], boxes:[], settings:{engine, model:'sam2.1-hiera-tiny', quality:'standard', searchRadius:15, motionThreshold:10, motionDamping:20, edgeMode:'guided', edgeRadius:3, edgeSmooth:1, faceThreshold:.5, faceExpand:15, faceShape:'outline'}},
 direction:'both', samDir: engine==='model' ? '/tmp/roto-work/vision/sam' : null, threads:4 };
let t=Date.now();
const out = await runRotoJob(spec, { onProgress:(f,s)=>{} });
console.log(engine, 'ms', Date.now()-t, {start:out.start,end:out.end,computed:out.computed,reused:out.reused,modelFrames:out.modelFrames});
// IoU vs ground truth per frame
let worst=1, sum=0;
for (let f=out.start; f<=out.end; f++){ const {data,width,height}=decodeGreyPng(readFileSync(`${store}/png/${out.frames[f]}.png`));
 const cx=200+6*f, cy=180+2*f; let i=0,u=0; for(let y=0;y<height;y++)for(let x=0;x<width;x++){const g=Math.hypot(x+.5-cx,y+.5-cy)<70; const m=data[y*width+x]>=128; if(g&&m)i++; if(g||m)u++;}
 const iou=i/u; worst=Math.min(worst,iou); sum+=iou;}
console.log('IoU mean', (sum/(out.end-out.start+1)).toFixed(4), 'worst', worst.toFixed(4));
t=Date.now(); const again = await runRotoJob(spec); console.log('rerun ms', Date.now()-t, again.reused, again.computed);
