import {test,expect} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
let vite:ViteDevServer;let url:string;
test.beforeAll(async()=>{vite=await createServer({server:{host:'127.0.0.1',port:0}});await vite.listen();url=vite.resolvedUrls!.local[0];});
test.afterAll(async()=>{await vite?.close();});
for(const dpr of [1,1.5,2])test(`incremental compositing matches full replay at DPR ${dpr}`,async({browser})=>{
  const context=await browser.newContext({deviceScaleFactor:dpr});const page=await context.newPage();
  await page.goto(`${url}benchmarks/render.html`);
  await page.waitForFunction(()=>typeof (window as any).verifyCanvasSequence==='function');
  const result=await page.evaluate(()=>(window as any).verifyCanvasSequence());
  expect(result).toEqual({checks:41,dpr});await context.close();
});
for(const dpr of [1,1.5,2])test(`mixed tail cache matches full replay at DPR ${dpr}`,async({browser})=>{
  const context=await browser.newContext({deviceScaleFactor:dpr});const page=await context.newPage();
  await page.goto(`${url}benchmarks/render.html`);
  await page.waitForFunction(()=>typeof (window as any).verifyMixedTailSequence==='function');
  const result=await page.evaluate(()=>(window as any).verifyMixedTailSequence());
  expect(result).toEqual({checks:18,dpr});await context.close();
});
