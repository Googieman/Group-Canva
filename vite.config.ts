import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendTarget = env.VITE_DEV_SERVER_URL?.trim() || env.BACKEND_URL?.trim() || `http://localhost:${env.BACKEND_PORT?.trim() || env.PORT?.trim() || '3000'}`;
  return { build: { outDir: 'dist/client' }, server: { proxy: { '/socket.io': { target: backendTarget, ws: true } } } };
});
