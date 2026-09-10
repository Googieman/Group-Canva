import {createServer,createConnection,type Socket} from 'node:net';

/** Local test-only transport delay. Both directions preserve byte order. */
export async function delayProxy(target:string,oneWayMs:number) {
  const endpoint=new URL(target);const sockets=new Set<Socket>();const timers=new Set<ReturnType<typeof setTimeout>>();
  const server=createServer(client=>{
    const upstream=createConnection({host:endpoint.hostname,port:Number(endpoint.port)});
    sockets.add(client);sockets.add(upstream);client.setNoDelay(true);upstream.setNoDelay(true);
    for(const [source,destination] of [[client,upstream],[upstream,client]]) {
      source.on('data',chunk=>{
        const timer=setTimeout(()=>{timers.delete(timer);if(!destination.destroyed)destination.write(chunk);},oneWayMs);
        timers.add(timer);
      });
      source.on('error',()=>destination.destroy());
      source.on('close',()=>{sockets.delete(source);destination.destroy();});
    }
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Proxy failed to bind');
  return {url:`http://127.0.0.1:${address.port}`,async close(){timers.forEach(clearTimeout);sockets.forEach(s=>s.destroy());await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
