import { chromium } from "@playwright/test";
const t = "https://residential-jax-crm.vercel.app";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const writes: string[] = [];
p.on("response", (r) => {
  const m = r.request().method();
  if (m !== "GET" && r.url().includes("/api/"))
    writes.push(`${m} ${r.status()} ${r.url().split("/api/")[1]?.slice(0, 40)}`);
});
await p.goto(t + "/searches", { waitUntil: "domcontentloaded", timeout: 90_000 });
await p.waitForTimeout(9000);
await p
  .getByRole("button", { name: /check for matches now/i })
  .first()
  .click()
  .catch(() => console.log("(button not found)"));
for (let i = 0; i < 60; i += 1) {
  if (writes.length) break;
  await p.waitForTimeout(2000);
}
await p.waitForTimeout(8000);
const text = (await p.locator("main").innerText()).replace(/\n+/g, " | ");
console.log("writes:", writes);
const m = text.match(/(Baseline recorded|alerts raised|matches now)[^|]*/);
console.log("result line:", m ? m[0].slice(0, 130) : "(none shown)");
const cap = text.match(/watching top [0-9,]+/);
console.log("cap disclosure:", cap ? cap[0] : "(not shown)");
await b.close();
