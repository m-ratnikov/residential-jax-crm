/**
 * Drive the deployed runtime the way a reviewer would.
 *
 * Not a unit test: this opens a real browser against a real URL, waits for
 * DuckDB-WASM to attach the published artifact over the gateway, and asserts
 * that the county-scale parcel count and a scored result actually appear. It is
 * the only check that proves the whole path - static wasm, range reads, criteria
 * SQL, scoring, rendering - works where it has to work.
 *
 *   npx tsx scripts/smoke.mts https://your-deployment.vercel.app
 */

import { chromium, type ConsoleMessage } from "@playwright/test";

const target = process.argv[2] ?? "http://localhost:3000";
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  console.log(`driving ${target}`);

  // 1. The dashboard loads at all.
  const response = await page.goto(`${target}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  check("dashboard responds", response?.status() === 200, `HTTP ${response?.status()}`);

  // 2. The header badge resolves, which only happens once the artifact has
  //    attached in the tab and been counted.
  await page.goto(`${target}/search`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const badge = page.getByTestId("dataset-badge");
  await badge.waitFor({ state: "visible", timeout: 180_000 }).catch(() => undefined);
  const badgeText = (await badge.textContent().catch(() => null))?.trim() ?? "";
  const parcels = Number(badgeText.replace(/[^0-9]/g, ""));
  check("artifact attached and counted", parcels > 0, `${badgeText || "no badge"}`);
  check("county scale, not a toy", parcels >= 50_000, `${parcels.toLocaleString("en-US")} parcels`);

  // 3. A criteria search returns scored rows with a rationale.
  await page.getByRole("button", { name: "Tired landlord" }).click();

  const matches = page.locator("h2", { hasText: /matches/ }).first();
  await matches.waitFor({ state: "visible", timeout: 120_000 }).catch(() => undefined);

  // Give the debounced search time to settle on a non-zero count.
  let matchText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    matchText = (await matches.textContent().catch(() => ""))?.trim() ?? "";
    if (/[1-9]/.test(matchText) && !/searching/i.test(matchText)) break;
    await page.waitForTimeout(1_000);
  }
  const matched = Number(matchText.replace(/[^0-9]/g, ""));
  check("criteria search returns matches", matched > 0, matchText || "no count");

  // 4. The first result carries a rationale naming real values.
  const rationale = page.locator("li button p").last();
  const rationaleText = (await rationale.textContent().catch(() => null))?.trim() ?? "";
  check(
    "match rationale cites evidence",
    /held \d+ years|roof about \d+ years|assessed at/.test(rationaleText),
    rationaleText.slice(0, 90),
  );

  // 5. The SQL behind the result is on the page, so the count is arguable.
  const sqlToggle = page.getByText("Show the SQL behind this result");
  check("result SQL is disclosed", await sqlToggle.isVisible().catch(() => false));

  // 6. Opening a parcel shows provenance, which is an acceptance criterion.
  await page.locator("li button").first().click();
  const provenance = page.getByText("Provenance", { exact: true }).first();
  await provenance.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  check("parcel drawer shows provenance", await provenance.isVisible().catch(() => false));

  // Console errors that are not the expected "no CRM store" noise.
  const realErrors = errors.filter(
    (text) => !/crm_store_not_configured|503|Failed to load resource/i.test(text),
  );
  check(
    "no unexpected console errors",
    realErrors.length === 0,
    realErrors.slice(0, 2).join(" | "),
  );

  await page.screenshot({ path: "smoke-search.png", fullPage: false });
  console.log("screenshot: smoke-search.png");

  await browser.close();

  if (failures.length) {
    console.log(`\n${failures.length} checks failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
