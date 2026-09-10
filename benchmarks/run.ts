import { chromium } from '@playwright/test';
import { createServer as createVite, transformWithEsbuild } from 'vite';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../server/app.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus,platform } from 'node:os';
import type { Command, Result, Snapshot, DrawingEvent } from '../shared/protocol.js';
import { delayProxy } from './delay.js';

const label = process.argv[2] || 'run';
if(!/^[a-z0-9-]+$/i.test(label))throw new Error('Use a simple output label');
const duration = Number(process.env.BENCH_DURATION_MS || 8000);
const repetitions = Number(process.env.BENCH_REPETITIONS || 3);
if(!Number.isInteger(duration)||duration<1000||duration>60000||!Number.isInteger(repetitions)||repetitions<1||repetitions>20)throw new Error('Duration must be 1000–60000 ms and repetitions 1–20');
const rendererRef=process.env.BENCH_RENDERER_REF;
const loadOnly=process.env.BENCH_PHASE==='load';
const delayMs=Number(process.env.BENCH_DELAY_MS||0);
if(!Number.isInteger(delayMs)||delayMs<0||delayMs>500)throw new Error('Delay must be 0–500 ms per direction');
if(delayMs&&process.env.BENCH_SERVER_URL)throw new Error('Use either an external server or local synthetic delay');
// Re-run a committed renderer with exactly the same current workload and
// diagnostics. This avoids maintaining a competing renderer implementation.
const baselineSource=rendererRef?execFileSync('git',['show',`${rendererRef}:client/canvas.ts`],{encoding:'utf8'})
  .replaceAll("'../shared/protocol'","'/shared/protocol'").replaceAll("'./diagnostics'","'/client/diagnostics'"):undefined;
const summarize=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return {count:s.length,p50:s[Math.max(0,Math.ceil(s.length*.5)-1)]??null,p95:s[Math.max(0,Math.ceil(s.length*.95)-1)]??null,max:s.at(-1)??null};};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const processing:number[]=[];
const backend = await createAppServer({host:'127.0.0.1',onCommandTiming:ms=>processing.push(ms)});
const proxy=delayMs?await delayProxy(backend.url,delayMs):undefined;
const target = process.env.BENCH_SERVER_URL || proxy?.url || backend.url;
const vite=await createVite({plugins:baselineSource?[{name:'benchmark-historical-renderer',enforce:'pre',
  resolveId(source,importer){if((source==='../client/canvas'||source==='./canvas')&&importer)return '\0benchmark-canvas.ts';},
  async load(id){if(id==='\0benchmark-canvas.ts')return (await transformWithEsbuild(baselineSource,'baseline-canvas.ts',{loader:'ts'})).code;},
}]:[],server:{port:0,host:'127.0.0.1',hmr:false,watch:null,proxy:{'/socket.io':{target,ws:true}}}});
await vite.listen();const url=vite.resolvedUrls!.local[0];
const browser=await chromium.launch({headless:true});
const clients:Socket[]=[];
async function connect(roomId:string) {
  const s=io(target,{transports:['websocket'],reconnection:false,autoConnect:false});clients.push(s);
  await new Promise<void>((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject);s.connect();});
  await new Promise<Snapshot>((resolve,reject)=>{s.once('room:snapshot',resolve);s.emit('room:join',{roomId,name:'Benchmark'},(r:Result)=>{if(!r.ok)reject(new Error(r.error));});});return s;
}
function command(s:Socket,c:Command) {return new Promise<void>((resolve,reject)=>s.timeout(8000).emit('command',c,(error:Error|null,r:Result)=>error||!r?.ok?reject(error||new Error(!r.ok?r.error:'Rejected')):resolve()));}
const renders:unknown[]=[];const loads:unknown[]=[];const inputs:unknown[]=[];
try {
  for(let rep=0;rep<repetitions;rep++) {
    const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});
    const page=await context.newPage();await page.goto(`${url}benchmarks/render.html?diagnostics=1`);
    await page.waitForFunction(()=>typeof (window as any).runCanvasBenchmark==='function');
    // Keep the original 300-stroke scenes and add an interval matrix for the
    // mixed tail. The matrix uses the same five-second (or configured)
    // duration and DPR 2 context for each repeat; diagnostics remain samples,
    // with no timing threshold used as a pass/fail assertion.
    for(const scenario of loadOnly?[]:['empty','completed-prefix','unfinished-prefix','unfinished-brush-prefix','mixed-tail-eraser-4','mixed-tail-eraser-7','mixed-tail-eraser-16']) {
      const result=await page.evaluate(({scenario,duration})=>(window as any).runCanvasBenchmark(scenario,duration),{scenario,duration});
      renders.push({rep,...result});console.log(JSON.stringify({phase:'renderer',rep,scenario,fps:result.fps,render:result.metrics.renderMs}));
    }
    const room=`bench-${Date.now()}`;
    await page.goto(`${url}?diagnostics=1&room=${room}`);
    await page.waitForSelector('.connection[data-status=connected]');
    if(!loadOnly) {
    await page.evaluate(()=>window.canvasDiagnostics!.reset());
    const box=(await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x+30,box.y+box.height/2);await page.mouse.down();
    const start=performance.now();let i=0;
    while(performance.now()-start<duration) {await page.mouse.move(box.x+30+(i*3)%(box.width-60),box.y+box.height/2+Math.sin(i*.1)*80);i++;await sleep(8);}
    await page.mouse.up();await sleep(150);
    inputs.push({rep,moves:i,...await page.evaluate(()=>window.canvasDiagnostics!.report())});
    }
    // Ten total clients: one real rendered observer and nine sockets, five sustained authors.
    const peers=await Promise.all(Array.from({length:9},()=>connect(room)));
    const roundTrips:number[]=[];
    for(let i=0;i<10;i++){const at=performance.now();await command(peers[8],{type:'history:redo'});roundTrips.push(performance.now()-at);}
    const observer=peers[8];const sent=new Map<string,number>();const received:number[]=[];let batches=0;
    observer.on('drawing:event',(e:DrawingEvent)=>{if(e.change.type==='stroke:points'){const at=sent.get(`${e.change.id}:${e.change.offset}`);if(at!==undefined)received.push(performance.now()-at);}});
    const ids=Array.from({length:5},(_,j)=>`load-${rep}-${j}`);
    for(let j=0;j<5;j++)await command(peers[j],{type:'stroke:begin',id:ids[j],tool:j===4?'eraser':'brush',color:'#5446d4',width:6,point:{x:30,y:30}});
    processing.length=0;await page.evaluate(()=>window.canvasDiagnostics!.reset());
    const loadStart=performance.now();let tick=0;const outstanding:Promise<void>[]=[];const intervals:number[]=[];let previous=loadStart;
    while(performance.now()-loadStart<duration) {
      const now=performance.now();intervals.push(now-previous);previous=now;
      for(let j=0;j<5;j++) {
        const offset=1+tick*2;sent.set(`${ids[j]}:${offset}`,performance.now());batches++;
        outstanding.push(command(peers[j],{type:'stroke:points',id:ids[j],offset,points:[{x:50+tick*2%1400,y:300+j*10},{x:51+tick*2%1400,y:301+j*10}]}));
      }
      tick++;await sleep(20);
    }
    await Promise.all(outstanding);for(let j=0;j<5;j++)await command(peers[j],{type:'stroke:end',id:ids[j]});
    await sleep(250);
    const visual=await page.evaluate(()=>window.canvasDiagnostics!.report());
    loads.push({rep,clients:10,authors:5,batches,ticks:tick,durationMs:performance.now()-loadStart,received:received.length,propagationMs:summarize(received),roundTripMs:summarize(roundTrips),batchIntervalMs:summarize(intervals.slice(1)),serverProcessingMs:!process.env.BENCH_SERVER_URL?summarize(processing):null,observer:visual});
    console.log(JSON.stringify({phase:'ten-clients',rep,propagation:summarize(received),processing:summarize(processing),fps:visual.fps}));
    peers.forEach(p=>p.disconnect());await context.close();
  }
  const report={label,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),rendererRef:rendererRef||'working-tree',platform:platform(),cpu:cpus()[0]?.model,browser:browser.version(),duration,repetitions,phase:loadOnly?'load':'all',targetKind:process.env.BENCH_SERVER_URL?'external-url':delayMs?'synthetic-delay':'same-machine',oneWayDelayMs:delayMs,renders,inputs,loads};
  await mkdir('benchmarks/results',{recursive:true});await writeFile(`benchmarks/results/${label}.json`,JSON.stringify(report,null,2));
  console.log(`Saved benchmarks/results/${label}.json`);
} finally { clients.forEach(c=>c.disconnect());await browser.close();await vite.close();await proxy?.close();await backend.close(); }
