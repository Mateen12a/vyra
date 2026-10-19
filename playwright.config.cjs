const { defineConfig } = require('@playwright/test');
// VYRA_URL (or the older ALTER_URL) lets the checks target a server on another port.
const baseURL = process.env.VYRA_URL || process.env.ALTER_URL || 'http://127.0.0.1:8799';
module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'chromium',
    baseURL,
    viewport: { width: 1440, height: 1080 },
    permissions: ['camera', 'microphone'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Its own port, so a developer's account-enabled server on 8765 is never reused by mistake.
    command: process.platform === 'win32' ? '.venv\\Scripts\\python.exe -m person_studio --port 8799' : '.venv/bin/python -m person_studio --port 8799',
    url: baseURL,
    reuseExistingServer: true,
    // These specs cover the workspace itself, so run without accounts (an empty value beats .env).
    env: { MONGO_URI: '', PERSON_ALLOWED_ORIGINS: 'http://127.0.0.1:8799,http://localhost:8799' },
  },
});
