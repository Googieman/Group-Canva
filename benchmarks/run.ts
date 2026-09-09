import { chromium } from '@playwright/test';
import { createServer as createVite } from 'vite';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../server/app.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus,platform } from 'node:os';
import type { Command, Result, Snapshot, DrawingEvent } from '../shared/protocol.js';

const label = process.argv[2] || 'run';
if(!/^[a-z0-9-]+$/i.test(label))throw new Error('Use a simple output label');
const duration = Number(process.env.BENCH_DURATION_MS || 8000);
const repetitions = Number(process.env.BENCH_REPETITIONS || 3);
const summarize=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return {count:s.length,p50:s[Math.max(0,Math.ceil(s.length*.5)-1)]??null,p95:s[Math.max(0,Math.ceil(s.length*.95)-1)]??null,max:s.at(-1)??null};};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const processing:number[]=[];
const backend = await createAppServer({host:'127.0.0.1',onCommandTiming:ms=>processing.push(ms)});
const target = process.env.BENCH_SERVER_URL || backend.url;
const vite=await createVite({server:{port:0,host:'127.0.0.1',proxy:{'/socket.io':{target,ws:true}}}});
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
    for(const scenario of ['empty','completed-prefix','unfinished-prefix']) {
      const result=await page.evaluate(({scenario,duration})=>(window as any).runCanvasBenchmark(scenario,duration),{scenario,duration});
      renders.push({rep,...result});console.log(JSON.stringify({phase:'renderer',rep,scenario,fps:result.fps,render:result.metrics.renderMs}));
    }
    const room=`bench-${Date.now()}`;
    await page.goto(`${url}?diagnostics=1&room=${room}`);
    await page.waitForSelector('.connection[data-status=connected]');
    await page.evaluate(()=>window.canvasDiagnostics!.reset());
    const box=(await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x+30,box.y+box.height/2);await page.mouse.down();
    const start=performance.now();let i=0;
    while(performance.now()-start<duration) {await page.mouse.move(box.x+30+(i*3)%(box.width-60),box.y+box.height/2+Math.sin(i*.1)*80);i++;await sleep(8);}
    await page.mouse.up();await sleep(150);
    inputs.push({rep,moves:i,...await page.evaluate(()=>window.canvasDiagnostics!.report())});
    // Ten total clients: one real rendered observer and nine sockets, five sustained authors.
    const peers=await Promise.all(Array.from({length:9},()=>connect(room)));
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
    loads.push({rep,clients:10,authors:5,batches,ticks:tick,durationMs:performance.now()-loadStart,received:received.length,propagationMs:summarize(received),batchIntervalMs:summarize(intervals.slice(1)),serverProcessingMs:target===backend.url?summarize(processing):null,observer:visual});
    console.log(JSON.stringify({phase:'ten-clients',rep,propagation:summarize(received),processing:summarize(processing),fps:visual.fps}));
    peers.forEach(p=>p.disconnect());await context.close();
  }
  const report={label,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),platform:platform(),cpu:cpus()[0]?.model,browser:browser.version(),duration,repetitions,targetKind:process.env.BENCH_SERVER_URL?'external-url':'same-machine',renders,inputs,loads};
  await mkdir('benchmarks/results',{recursive:true});await writeFile(`benchmarks/results/${label}.json`,JSON.stringify(report,null,2));
  console.log(`Saved benchmarks/results/${label}.json`);
} finally { clients.forEach(c=>c.disconnect());await browser.close();await vite.close();await backend.close(); }
