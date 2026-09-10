import { CanvasBoard } from '../client/canvas';
import { diagnostics } from '../client/diagnostics';
import type { Stroke } from '../shared/protocol';

// Uses the real renderer. This fixture stays outside the production Vite entry.
const canvas = document.querySelector('canvas')!;
const board = new CanvasBoard(canvas,{onBegin(){},onPoints(){},onEnd(){},onCancel(){},onCursor(){}});
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(()=>resolve()));
function stroke(i:number, points:number, completed:boolean, allBrush=false, eraserEvery=7, oneBasedEraser=false): Stroke {
  const eraser = oneBasedEraser ? (i + 1) % eraserEvery === 0 : i % eraserEvery === 0;
  return {id:`s${i}`,userId:'fixture',tool:allBrush?'brush':eraser?'eraser':'brush',color:'#5446d4',width:6,
    order:i+1,completed,completionOrder:completed?i+1:null,active:true,
    points:Array.from({length:points},(_,p)=>({x:((p*2+i*19)%1500)+50,y:300+Math.sin(p*.08+i)*120}))};
}
async function run(scenario:string, durationMs:number) {
  const allBrush=scenario==='unfinished-brush-prefix';
  const mixedMatch = /^mixed-tail-eraser-(4|7|16)$/.exec(scenario);
  const eraserEvery = mixedMatch ? Number(mixedMatch[1]) : 7;
  const oneBasedEraser = Boolean(mixedMatch);
  const unfinishedEarly = scenario==='unfinished-prefix'||allBrush||Boolean(mixedMatch);
  let strokes = scenario==='empty' ? [] : Array.from({length:300},(_,i)=>stroke(i,120,true,allBrush,eraserEvery,oneBasedEraser));
  if(unfinishedEarly) strokes[0]={...strokes[0],completed:false,completionOrder:null};
  if(mixedMatch) strokes[0]={...strokes[0],tool:'brush'};
  // Keep the appended operation live and brush-shaped in every mixed-tail
  // interval so its updates exercise ordered replay around the fixture's
  // erasers rather than changing the workload's operation type.
  let live={...stroke(300,1,false,allBrush,eraserEvery,oneBasedEraser),tool:'brush' as const};strokes.push(live);board.setStrokes(strokes);
  await nextFrame();await nextFrame();diagnostics!.reset();
  const started=performance.now();let updates=0;
  while(performance.now()-started<durationMs) {
    const t=performance.now();
    live={...live,points:[...live.points,{x:50+(updates*3)%1500,y:300+Math.sin(updates*.1)*150}]};
    if(unfinishedEarly) {
      const first=strokes[0];strokes[0]={...first,points:[...first.points,{x:50+updates%1500,y:400}]};
    }
    strokes[strokes.length-1]=live;
    diagnostics!.input(t);board.setStrokes([...strokes]);updates++;
    await nextFrame();
  }
  await nextFrame();return {scenario,eraserEvery:mixedMatch?eraserEvery:null,updates,...diagnostics!.report(),backing:{width:canvas.width,height:canvas.height}};
}
Object.assign(window,{runCanvasBenchmark:run});

// Functional oracle: independent full replay, never used for timed measurements.
async function verifySequence() {
  const reference=document.createElement('canvas');reference.width=canvas.width;reference.height=canvas.height;
  const ctx=reference.getContext('2d')!;
  let checks=0;
  const check=async(strokes:Stroke[])=>{
    board.setStrokes(strokes);await nextFrame();
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,reference.width,reference.height);
    const dpr=reference.width/1600;ctx.setTransform(dpr,0,0,dpr,0,0);
    for(const s of [...strokes].filter(s=>s.active).sort((a,b)=>a.order-b.order)) {
      ctx.globalCompositeOperation=s.tool==='eraser'?'destination-out':'source-over';
      ctx.strokeStyle=ctx.fillStyle=s.color;ctx.lineWidth=s.width;ctx.lineCap=ctx.lineJoin='round';ctx.beginPath();
      if(s.points.length===1){ctx.arc(s.points[0].x,s.points[0].y,s.width/2,0,Math.PI*2);ctx.fill();}
      else if(s.points.length){ctx.moveTo(s.points[0].x,s.points[0].y);for(const p of s.points.slice(1))ctx.lineTo(p.x,p.y);ctx.stroke();}
    }
    const actual=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    const expected=ctx.getImageData(0,0,reference.width,reference.height).data;
    let mismatches=0;const examples:unknown[]=[];
    // Canvas engines can change edge coverage when clipping a path. Require
    // exact interiors and confine any raster differences to a one-pixel edge
    // neighborhood. A cached transparent raster can quantize an opaque brush
    // color by one channel value in WebKit; that bounded rounding is allowed,
    // while alpha and eraser interiors must remain exactly clear.
    for(let i=0;i<actual.length;i+=4) {
      if(actual.slice(i,i+4).every((v,c)=>v===expected[i+c]))continue;
      if(actual[i+3]===expected[i+3] && [0,1,2].every(c=>Math.abs(actual[i+c]-expected[i+c])<=1))continue;
      const x=i/4%canvas.width,y=Math.floor(i/4/canvas.width);
      let edge=false;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
        if(x+dx<0||x+dx>=canvas.width||y+dy<0||y+dy>=canvas.height)continue;
        const neighbor=((y+dy)*canvas.width+x+dx)*4;
        if(expected.slice(neighbor,neighbor+4).some((v,c)=>v!==expected[i+c]))edge=true;
      }
      if(!edge){mismatches++;if(examples.length<8)examples.push({x,y,actual:[...actual.slice(i,i+4)],expected:[...expected.slice(i,i+4)]});}
    }
    if(mismatches)throw new Error(`Replay interior mismatch at step ${checks}: ${mismatches} pixels; ${JSON.stringify(examples)}`);
    checks++;
  };
  let lower:Stroke={...stroke(1,1,false),id:'lower',order:1,tool:'brush',width:24,points:[{x:100,y:400},{x:350,y:400}]};
  let eraser:Stroke={...stroke(2,1,false),id:'eraser',order:2,tool:'eraser',width:48,points:[{x:400,y:300},{x:400,y:500}]};
  let upper:Stroke={...stroke(3,1,true),id:'upper',order:3,color:'#ee5533',width:8,points:[{x:200,y:450},{x:600,y:350}]};
  await check([lower,eraser,upper]);
  // Reverse completion, late lower points below the eraser, then history changes.
  eraser={...eraser,completed:true,completionOrder:1};await check([lower,eraser,upper]);
  lower={...lower,points:[...lower.points,{x:650,y:400}]};await check([lower,eraser,upper]);
  lower={...lower,completed:true,completionOrder:3};await check([lower,eraser,upper]);
  lower={...lower,active:false};await check([lower,eraser,upper]);
  eraser={...eraser,active:false};await check([lower,eraser,upper]);
  lower={...lower,active:true};eraser={...eraser,active:true};await check([lower,eraser,upper]);
  // Snapshot replaces interior points in place; removal/cancellation; provisional order settles.
  lower.points[1].y=470;await check([lower,eraser,upper]);
  await check([lower,upper]);upper={...upper,order:0};await check([lower,upper]);
  // Reorder across the still-present eraser, then restore the operation's
  // original visual position. This exercises begin-order replay independent
  // of completion order and proves the eraser is not moved by history state.
  upper={...upper,order:3};await check([lower,eraser,upper]);
  upper={...upper,order:0};await check([lower,eraser,upper]);
  await check([]);
  lower={...lower,completed:false,points:[{x:0,y:0}],width:63};
  eraser={...eraser,points:[{x:70.5,y:0},{x:70.5,y:180}]};
  for(let i=0;i<24;i++){
    lower={...lower,points:[...lower.points,{x:i*13.37,y:40+Math.sin(i*.73)*35}]};
    await check([lower,eraser]);
  }
  // Long completed brush runs are rasterized as one cached operation between
  // live strokes. Keep a later eraser in the sequence to prove the cache is
  // inserted at its original visual position.
  let live={...stroke(90,1,false,true),id:'live',order:90,points:[{x:180,y:650},{x:280,y:650}]};
  const tail=Array.from({length:12},(_,i)=>({...stroke(100+i,3,true,true),id:`tail-${i}`,order:91+i,completionOrder:20+i,
    points:[{x:300+i*12,y:620},{x:480+i*12,y:680}]}));
  let trailingEraser: Stroke={...stroke(130,2,false),id:'trailing-eraser',order:110,tool:'eraser',points:[{x:520,y:600},{x:520,y:760}]};
  await check([live,...tail,trailingEraser]);
  live={...live,points:[...live.points,{x:360,y:640}]};await check([live,...tail,trailingEraser]);
  // Invalidate the cached brush run itself while preserving the later eraser.
  // The full replay remains the delivery-independent oracle for this change.
  tail[4]={...tail[4],points:[...tail[4].points,{x:420,y:700}]};await check([live,...tail,trailingEraser]);
  trailingEraser={...trailingEraser,completed:true,completionOrder:40};await check([live,...tail,trailingEraser]);
  return {checks,dpr:reference.width/1600};
}
Object.assign(window,{verifyCanvasSequence:verifySequence});
