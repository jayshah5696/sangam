import { chromium } from "@playwright/test";

const base = process.env.SANGAM_URL ?? "http://127.0.0.1:8000";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "/tmp/sangam-demo-raw", size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

await page.goto(base, { waitUntil: "domcontentloaded" });
await pause(3000);

// open a document from the tree
const docLink = page.getByText("Evaluating RAG systems", { exact: false }).first();
await docLink.click();
await pause(3500);

// history tab in inspector
const hist = page.getByRole("button", { name: /history/i }).first();
if (await hist.count()) { await hist.click().catch(() => {}); }
await pause(2500);

// back to properties, then full-text search
const props = page.getByRole("button", { name: /properties/i }).first();
if (await props.count()) { await props.click().catch(() => {}); }
await pause(800);
await page.getByRole("button", { name: /search workspace/i }).first().click();
await pause(1200);
const box = page.getByPlaceholder(/title, text, path/i).first();
await box.click();
await box.type("retrieval", { delay: 70 });
await pause(2600);

// first-class workspace chat
await page.locator('a[href="/chat"]').click();
await pause(3000);

// publications
await page.locator('a[href="/publications"]').click();
await pause(2600);

// agent activity
await page.goto(base + "/activity");
await pause(2800);

// end on files overview
await page.getByRole("button", { name: /^Files$/ }).first().click().catch(() => {});
await pause(2000);

await context.close();
await browser.close();
console.log("done");
