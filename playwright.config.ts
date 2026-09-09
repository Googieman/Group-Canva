import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel:false, workers:1, timeout:30000,
  use:{baseURL:'http://127.0.0.1:3000',trace:'retain-on-failure'},
  webServer:{command:'npm start',url:'http://127.0.0.1:3000/health',reuseExistingServer:!process.env.CI,timeout:120000},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}},{name:'firefox',use:{...devices['Desktop Firefox']}},{name:'webkit',use:{...devices['Desktop Safari']}}],
});
