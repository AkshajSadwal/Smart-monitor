import {defineConfig,devices} from '@playwright/test';
import {resolve} from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.local/browsers');
export default defineConfig({
  testDir:'tests/browser',workers:1,timeout:45_000,
  projects:[{name:'chromium',use:{...devices['Desktop Chrome'],launchOptions:{args:['--no-proxy-server','--enable-unsafe-swiftshader']}}}],
  reporter:'list',
});
