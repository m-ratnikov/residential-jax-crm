import { chromium } from "@playwright/test";
const t = process.argv[2] ?? "https://residential-jax-crm.vercel.app";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
p.on("response", (r) => {
  if (r.url().includes("/api/llm/"))
    console.log("LLM CALL:", r.status(), r.url().split("/api/llm/")[1]);
});

await p.goto(t + "/agent", { waitUntil: "domcontentloaded", timeout: 90_000 });
await p.waitForTimeout(5000);
console.log("dropdown:", await p.locator("select option").allTextContents());

await p
  .getByRole("button", { name: /How many parcels have I got in each acquisition stage/ })
  .click();
console.log("asked, waiting for the answer...");

const answer = p.locator("article, [data-testid='answer'], .prose").first();
for (let i = 0; i < 150; i += 1) {
  const busy = await p.getByText("Working through the data").count();
  if (!busy && i > 3) break;
  await p.waitForTimeout(2000);
}
const text = (await p.locator("main").innerText()).replace(/\n+/g, " | ");
console.log("\n--- page after the turn ---\n" + text.slice(0, 1800));
await p.screenshot({ path: "dbg-ask.png", fullPage: true });
await b.close();
