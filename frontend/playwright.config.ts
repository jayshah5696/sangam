import { defineConfig, devices } from '@playwright/test'

const port = process.env.SANGAM_E2E_PORT ?? '8765'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'bash scripts/run-e2e-server.sh',
    url: `http://127.0.0.1:${port}/api/v1/readiness`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'chromium-touch-mobile',
      testMatch:
        /(?:projects|capture-projects-screenshots|crisp-ui|html-javascript|chat-publications|activity-token|motion|workspace-organizer|pdf-reader|create-to-write|workspace-evidence|review-inbox)\.spec\.ts/,
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'webkit-mobile-evidence',
      testMatch: /(?:workspace-evidence|create-to-write)\.spec\.ts/,
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'webkit-mobile-pdf',
      testMatch: /pdf-reader\.spec\.ts/,
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'webkit-mobile-projects',
      testMatch: /projects\.spec\.ts$/,
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'webkit-mobile-editorial',
      testMatch: /review-inbox\.spec\.ts/,
      use: { ...devices['iPhone 13'] },
    },
  ],
})
