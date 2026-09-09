import { test, expect, type Page } from '@playwright/test';
async function ink(page:Page) {
  return page.locator('canvas').evaluate((canvas:HTMLCanvasElement) => {
    const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    let count=0;for(let i=3;i<data.length;i+=4)if(data[i]>0)count++;
    return count;
  });
}
async function path(page:Page,start=[.3,.45],end=[.65,.55],release=true) {
  const box=(await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x+box.width*start[0],box.y+box.height*start[1]);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*end[0],box.y+box.height*end[1],{steps:12});
  if(release)await page.mouse.up();
}
test('three canvases stream live strokes, erase, globally undo and redo, and hydrate late join',async({browser},testInfo)=>{
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  const pages=await Promise.all([context.newPage(),context.newPage(),context.newPage()]);
  const url=`/?room=browser-${testInfo.project.name}-${Date.now()}`;
  for(const p of pages){await p.goto(url);await expect(p.getByText('Live together', {exact:true})).toBeVisible({timeout:15000});}
  await path(pages[0],undefined,undefined,false);
  await expect.poll(()=>ink(pages[1])).toBeGreaterThan(100);
  await expect.poll(()=>ink(pages[2])).toBeGreaterThan(100);
  await pages[0].mouse.up();
  const drawn=await ink(pages[1]);
  await pages[1].getByRole('button',{name:/undo/i}).click();
  for(const p of pages) await expect.poll(()=>ink(p)).toBe(0);
  await pages[2].getByRole('button',{name:/redo/i}).click();
  await expect.poll(()=>ink(pages[0])).toBe(drawn);
  await pages[1].getByRole('button',{name:/eraser/i}).click();
  await path(pages[1]);
  await expect.poll(()=>ink(pages[0])).toBeLessThan(drawn);
  await pages[0].getByRole('button',{name:/undo/i}).click();
  await expect.poll(()=>ink(pages[2])).toBe(drawn);
  const late=await context.newPage();await late.goto(url);
  await expect.poll(()=>ink(late)).toBe(drawn);
  await pages[0].screenshot({path:`test-results/${testInfo.project.name}-desktop.png`,fullPage:true});
  await context.close();
});
test('keyboard controls, resize and reconnect preserve a completed drawing',async({browser},testInfo)=>{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await context.newPage();
  await page.goto(`/?room=resize-${testInfo.project.name}-${Date.now()}`);
  await expect(page.getByText('Live together',{exact:true})).toBeVisible({timeout:15000});
  await page.keyboard.press('e'); await expect(page.getByRole('button',{name:/eraser/i})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('b'); await path(page);
  await expect(page.getByRole('button',{name:/undo/i})).toBeEnabled();
  await page.keyboard.press('Control+z'); await expect.poll(()=>ink(page)).toBe(0);
  await page.keyboard.press('Control+Shift+z'); await expect.poll(()=>ink(page)).toBeGreaterThan(100);
  await context.setOffline(true); await expect(page.getByText(/Connection lost|Reconnecting|Offline|Disconnected/).first()).toBeVisible({timeout:15000});
  await context.setOffline(false); await expect(page.getByText('Live together',{exact:true})).toBeVisible({timeout:20000});
  await expect.poll(()=>ink(page)).toBeGreaterThan(100);
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>ink(page)).toBeGreaterThan(10);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const box=(await page.locator('canvas').boundingBox())!;expect(Math.abs(box.width/box.height-1600/900)).toBeLessThan(.03);
  await page.screenshot({path:`test-results/${testInfo.project.name}-mobile.png`,fullPage:true});
  await context.close();
});
