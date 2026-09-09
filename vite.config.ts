import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: 'dist/client' }, server: { proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } } } });
