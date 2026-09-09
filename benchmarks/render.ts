import { CanvasBoard } from '../client/canvas';
import { diagnostics } from '../client/diagnostics';
import type { Stroke } from '../shared/protocol';

// Uses the real renderer. This fixture stays outside the production Vite entry.
const canvas = document.querySelector('canvas')!;
const board = new CanvasBoard(canvas,{onBegin(){},onPoints(){},onEnd(){},onCancel(){},onCursor(){}});
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(()=>resolve()));
function stroke(i:number, points:number, completed:boolean): Stroke {
  return {id:`s${i}`,userId:'fixture',tool:i%7===0?'eraser':'brush',color:'#5446d4',width:6,
    order:i+1,completed,completionOrder:completed?i+1:null,active:true,
    points:Array.from({length:points},(_,p)=>({x:((p*2+i*19)%1500)+50,y:300+Math.sin(p*.08+i)*120}))};
}
async function run(scenario:string, durationMs:number) {
  let strokes = scenario==='empty' ? [] : Array.from({length:300},(_,i)=>stroke(i,120,true));
  if(scenario==='unfinished-prefix') strokes[0]={...strokes[0],completed:false,completionOrder:null};
  let live=stroke(300,1,false);strokes.push(live);board.setStrokes(strokes);
  await nextFrame();await nextFrame();diagnostics!.reset();
  const started=performance.now();let updates=0;
  while(performance.now()-started<durationMs) {
    const t=performance.now();
    live={...live,points:[...live.points,{x:50+(updates*3)%1500,y:300+Math.sin(updates*.1)*150}]};
    if(scenario==='unfinished-prefix') {
      const first=strokes[0];strokes[0]={...first,points:[...first.points,{x:50+updates%1500,y:400}]};
    }
    strokes[strokes.length-1]=live;
    diagnostics!.input(t);board.setStrokes([...strokes]);updates++;
    await nextFrame();
  }
  await nextFrame();return {scenario,updates,...diagnostics!.report(),backing:{width:canvas.width,height:canvas.height}};
}
Object.assign(window,{runCanvasBenchmark:run});
