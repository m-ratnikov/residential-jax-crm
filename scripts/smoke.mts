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
  //
  // The count is read by waiting for it to CHANGE, not merely to be non-zero:
  // the unfiltered county count is on screen before the thesis is applied, and
  // a check that accepts the first number it sees passes on the wrong one.
  const heading = page
    .locator("h2")
    .filter({ hasText: /matches|Searching/ })
    .first();

  const settledCount = async (): Promise<number> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const text = ((await heading.textContent().catch(() => "")) ?? "").trim();
      if (!/searching/i.test(text)) {
        const digits = text.replace(/[^0-9]/g, "");
        if (digits && Number(digits) > 0) return Number(digits);
      }
      await page.waitForTimeout(1_000);
    }
    return 0;
  };

  const changedCount = async (from: number): Promise<number> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await settledCount();
      if (value !== from) return value;
      await page.waitForTimeout(1_000);
    }
    return from;
  };

  await heading.waitFor({ state: "visible", timeout: 120_000 }).catch(() => undefined);
  const unfiltered = await settledCount();

  await page.getByRole("button", { name: "Tired landlord" }).click();
  const matched = await changedCount(unfiltered);
  check(
    "criteria search returns matches",
    matched > 0 && matched < unfiltered,
    `${matched.toLocaleString("en-US")} of ${unfiltered.toLocaleString("en-US")}`,
  );

  // 4. The first result carries a rationale naming real values.
  const rationale = page.locator("li button p").last();
  const rationaleText = (await rationale.textContent().catch(() => null))?.trim() ?? "";
  check(
    "match rationale cites evidence",
    /held \d+ years|roof about \d+ years|assessed at/.test(rationaleText),
    rationaleText.slice(0, 90),
  );

  // 4b. The score is a number.
  //
  // It was NaN for a while, on every row, in the browser and nowhere else: a
  // decimal literal makes DuckDB type the score column DECIMAL, Arrow carries a
  // decimal as a Uint32Array, and the row converter turned that into a JSON
  // string. The native engine was unaffected, so the unit tests and the seed
  // script all agreed the scoring worked.
  const scoreBadge = page.getByTestId("score").first();
  const badgeValue = ((await scoreBadge.textContent().catch(() => "")) ?? "").trim();
  check(
    "the score is a number",
    /^[0-9]+(\.[0-9]+)?$/.test(badgeValue),
    badgeValue || "no score badge",
  );

  // 4c. The map actually drew the parcels.
  //
  // Also silent when broken: MapLibre resolves its worker relative to
  // `import.meta.url`, which inside a Next bundle is the page, so the worker
  // started on the page's own HTML and died. A GeoJSON source with no worker
  // holds every feature it is given and tiles none of them - no error, no
  // warning, an empty city under a working basemap.
  const canvas = page.getByTestId("map-canvas");
  let plotted = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    plotted = Number((await canvas.getAttribute("data-parcels-drawn").catch(() => "0")) ?? 0);
    if (plotted > 0) break;
    await page.waitForTimeout(1_000);
  }
  check("the map drew the matches", plotted > 0, `${plotted} parcels on screen`);

  // 4d. The map drives the search.
  //
  // Turning on "Search this view" and zooming in has to narrow the result set,
  // because the point of a map-driven CRM is that the thing on screen is the
  // thing being counted.
  const countyWide = await settledCount();
  await page.getByRole("button", { name: "Search this view" }).click();
  await page.waitForTimeout(3_000);
  for (let step = 0; step < 3; step += 1) {
    await page
      .getByRole("button", { name: "Zoom in" })
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(1_200);
  }
  const inView = await changedCount(countyWide);

  check(
    "zooming the map narrows the search",
    inView > 0 && inView < countyWide,
    `${countyWide.toLocaleString("en-US")} county wide, ${inView.toLocaleString("en-US")} in view`,
  );
  check(
    "the list says the view is what narrowed it",
    await page
      .getByText("in this view", { exact: true })
      .first()
      .isVisible()
      .catch(() => false),
  );

  // Back to the whole county for the checks that follow.
  await page.getByRole("button", { name: "Search this view" }).click();
  await page.waitForTimeout(2_000);

  // 5. The SQL behind the result is on the page, so the count is arguable.
  const sqlToggle = page.getByText("Show the SQL behind this result");
  check("result SQL is disclosed", await sqlToggle.isVisible().catch(() => false));

  // 6. Opening a parcel shows provenance, which is an acceptance criterion.
  await page.locator("li button").first().click();
  const provenance = page.getByText("Provenance", { exact: true }).first();
  await provenance.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  check("parcel drawer shows provenance", await provenance.isVisible().catch(() => false));

  // 7. The CRM half. Searching a parquet is half the story; the assignment is a
  //    CRM, so the deployed runtime has to show real saved criteria and real
  //    worked deals read back out of the store, not an empty board.
  await page.keyboard.press("Escape");

  await page.goto(`${target}/searches`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const open = page.getByRole("button", { name: "Open", exact: true });
  await open
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => undefined);
  const savedCount = await open.count();
  check("saved criteria are read back from the store", savedCount > 0, `${savedCount} saved`);

  const evaluated = await page.getByText(/Matched last pass/i).count();
  check(
    "each saved thesis records what it matched",
    evaluated === savedCount && savedCount > 0,
    `${evaluated} baselined`,
  );

  await page.goto(`${target}/opportunities`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // The board is the default view and the table is behind a toggle, so read the
  // count the page itself reports rather than counting DOM rows. Polled rather
  // than read once: "0 of 0 shown" renders before the fetch resolves, so a
  // single read is a race this loses about half the time.
  const shown = page.getByText(/[0-9]+ of [0-9]+ shown/).first();
  let shownText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    shownText = ((await shown.textContent().catch(() => "")) ?? "").trim();
    if (/^[1-9]/.test(shownText)) break;
    await page.waitForTimeout(1_000);
  }
  const deals = Number(shownText.split(" of ")[0]);
  check("the acquisition board has worked deals", deals > 0, shownText || "no count");

  await page
    .getByRole("button", { name: "Table", exact: true })
    .click()
    .catch(() => undefined);
  const tableRows = await page.getByRole("row").count();
  check(
    "the table view lists them individually",
    tableRows > deals,
    `${tableRows} rows including the header`,
  );

  // A funnel, not a pile: several stages have to be occupied for the board to
  // demonstrate anything about a lifecycle.
  const counts = await Promise.all(
    ["Identified", "Contacted", "Negotiating", "Under contract", "Closed"].map((stage) =>
      page.getByText(stage, { exact: false }).count(),
    ),
  );
  const occupied = counts.filter((n) => n > 0).length;
  check("deals are spread across the funnel", occupied >= 3, `${occupied} stages present`);

  // 7b. The Ask page offers models without asking for a key.
  //
  // Deliberately not a real question: a turn costs tokens on the deployment's
  // own account, and a smoke test that spends money every time it runs is a
  // smoke test people stop running. What is checked is the part that breaks
  // silently - whether this deployment still has a key and still publishes the
  // models it will spend it on.
  await page.goto(`${target}/agent`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const models = page.locator("select option");
  await models
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => undefined);
  const offered = await models.count();
  check("the agent offers models with no key to configure", offered > 0, `${offered} models`);
  check(
    "and asks the visitor for no key at all",
    (await page.getByText("no model configured", { exact: false }).count()) === 0 &&
      (await page.getByRole("link", { name: /key|settings/i }).count()) === 0,
  );

  // 8. The store is attached and writable, which the header says out loud when
  //    it is not. Neither badge may be present on a correctly configured
  //    deployment.
  const readOnly = await page.getByText("Read only", { exact: true }).count();
  const ephemeral = await page.getByText("In-memory store", { exact: true }).count();
  check(
    "the store is attached and writable",
    readOnly === 0 && ephemeral === 0,
    readOnly ? "header says read only" : ephemeral ? "header says in-memory" : "no warning badge",
  );

  // Failed requests are worth seeing, but a 503 from a deliberately read-only
  // deployment is a state the UI renders rather than an error to fail on.
  const realErrors = errors.filter(
    (text) => !/crm_store_not_writable|Failed to load resource/i.test(text),
  );
  check(
    "no unexpected console errors",
    realErrors.length === 0,
    realErrors.slice(0, 2).join(" | "),
  );

  await page.goto(`${target}/search`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page
    .getByTestId("dataset-badge")
    .waitFor({ state: "visible", timeout: 180_000 })
    .catch(() => undefined);
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
