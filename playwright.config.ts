import { defineConfig, devices } from '@playwright/test';
const e2ePort = Number(process.env.E2E_PORT ?? 3000);
export default defineConfig({
  testDir: './tests/browser', fullyParallel:false, workers:1, timeout:30000,
  use:{baseURL:`http://127.0.0.1:${e2ePort}`,trace:'retain-on-failure'},
  webServer:{command:'npm start',url:`http://127.0.0.1:${e2ePort}/health`,env:{PORT:String(e2ePort)},reuseExistingServer:!process.env.CI,timeout:120000},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}},{name:'firefox',use:{...devices['Desktop Firefox']}},{name:'webkit',use:{...devices['Desktop Safari']}}],
});
