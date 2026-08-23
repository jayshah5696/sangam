import { chromium } from "@playwright/test";

const base = process.env.SANGAM_URL ?? "http://sangam:8000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/sangam-probe-home.png" });
console.log("URL:", page.url());
console.log("TITLE:", await page.title());

const buttons = await page.getByRole("button").all();
for (const b of buttons.slice(0, 25)) {
  const label = (await b.textContent())?.trim() ?? "";
  if (label) console.log("button:", label.slice(0, 60));
}
const links = await page.getByRole("link").all();
for (const l of links.slice(0, 15)) {
  console.log("link:", ((await l.textContent()) ?? "").trim().slice(0, 60));
}
const searchbox = page.getByRole("searchbox");
console.log("searchboxes:", await searchbox.count());
const textbox = page.getByRole("textbox");
console.log("textboxes:", await textbox.count());
await browser.close();
