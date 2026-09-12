import { createAppServer } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
const server = await createAppServer({ port, host: process.env.HOST ?? '0.0.0.0', persistencePath: process.env.PERSISTENCE_PATH });
console.log(`Group Canvas is listening at ${server.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close(); });
