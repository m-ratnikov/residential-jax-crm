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
 *
 * The rule every assertion here is held to: **it must fail in the state it
 * exists to rule out.** A check that also passes when the thing is broken is
 * decoration, and it is worse than no check because it reads like evidence.
 *
 * Two of them used to break that rule and are called out where they appear:
 *
 *  - the parcel count asserted `>= 50_000`, which the bundled 75,988 parcel
 *    sample passes. The whole purpose of that line is to prove the deployment is
 *    on the 404,023 parcel county artifact rather than the sample, and it could
 *    not tell them apart. It now asserts county scale AND that the badge is not
 *    the SAMPLE badge AND that the parquet bytes came off the IPFS gateway
 *    rather than this deployment's own /sample/ path.
 *  - the funnel check counted page text matching each stage name, which the
 *    stage filter's own dropdown options supply on an empty board. It now reads
 *    the stages off the opportunities the API actually returns.
 */

import { chromium, type ConsoleMessage, type Request } from "@playwright/test";

const target = process.argv[2] ?? "http://localhost:3000";
const failures: string[] = [];

/**
 * The floor for "this is the county, not the sample".
 *
 * Duval publishes 404,023 parcels and the bundled sample is 75,988, so any
 * number between them separates the two states. This sits well clear of both:
 * far enough above the sample that no sample can reach it, far enough below the
 * published total that a genuine county republish moving the roll by a few
 * thousand parcels does not turn the check red.
 */
const COUNTY_SCALE_MIN = 300_000;

/**
 * The floor for "the run history is the mutable IPNS name, not a pinned CID".
 *
 * RUN_HISTORY_URL can be pointed at either. A CID is immutable, so pointing at
 * one freezes /pipeline at however many runs it held when it was pinned - which
 * is exactly the state this rules out, since the page exists to show a history
 * that grows. The pipeline merges its published history on every publish and
 * cannot shorten it, so this floor only ever moves up.
 */
const RUN_HISTORY_MIN = 20;

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

  // Where the parquet bytes actually came from.
  //
  // This is the only unforgeable answer to "is this the published artifact or
  // the bundled sample": the badge is rendered from configuration and would say
  // whatever it was told, but the range reads are the reads DuckDB-WASM really
  // made. A deployment on the sample fetches /sample/query-table.parquet off its
  // own static output; a deployment on the county artifact fetches the gateway.
  const parquetReads: string[] = [];
  page.on("request", (request: Request) => {
    const url = request.url();
    if (/query-table\.parquet|\/ipns\/|\/ipfs\//i.test(url)) parquetReads.push(url);
  });

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
  const badgeTitle = (await badge.getAttribute("title").catch(() => null))?.trim() ?? "";
  const parcels = Number(badgeText.replace(/[^0-9]/g, ""));
  check("artifact attached and counted", parcels > 0, `${badgeText || "no badge"}`);

  // Three independent readings of the same fact, because the one that used to
  // stand here alone (`parcels >= 50_000`) is passed by the 75,988 parcel
  // sample, and proving the deployment is NOT on the sample is the entire
  // reason the line exists.
  check(
    "county scale, not a toy",
    parcels >= COUNTY_SCALE_MIN,
    `${parcels.toLocaleString("en-US")} parcels, floor ${COUNTY_SCALE_MIN.toLocaleString("en-US")}`,
  );
  check(
    "the source is the published artifact, not the sample",
    !/sample/i.test(badgeText) && /published/i.test(badgeTitle),
    badgeTitle ? badgeTitle.slice(0, 90) : badgeText || "no badge",
  );
  const gatewayReads = parquetReads.filter((url) => /\/ipns\/|\/ipfs\//i.test(url));
  const sampleReads = parquetReads.filter((url) => /\/sample\//i.test(url));
  check(
    "the parquet bytes came off the gateway",
    gatewayReads.length > 0 && sampleReads.length === 0,
    `${gatewayReads.length} gateway reads, ${sampleReads.length} sample reads`,
  );

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

  // The heading is not the evidence. The panel renders with "not published" in
  // every row when the artifact carries no provenance, which is precisely the
  // state "preserve source provenance for all displayed records" rules out. So
  // read the values, by label, and require a source URL a reviewer can click.
  const cell = async (label: string): Promise<string> =>
    (
      (await page
        .locator(`dt:text-is("${label}") + dd`)
        .first()
        .textContent()
        .catch(() => "")) ?? ""
    ).trim();

  const sourceSystem = await cell("Source system");
  const pipelineRun = await cell("Pipeline run");
  const sourceHref = await page
    .locator('dt:text-is("Source") + dd a')
    .first()
    .getAttribute("href")
    .catch(() => null);

  check(
    "and the provenance carries real values",
    Boolean(sourceSystem) &&
      sourceSystem !== "not published" &&
      Boolean(pipelineRun) &&
      pipelineRun !== "not published" &&
      /^https?:\/\//i.test(sourceHref ?? ""),
    `system=${sourceSystem || "-"}, run=${pipelineRun || "-"}, source=${sourceHref ? "linked" : "absent"}`,
  );

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

  // 7a. Converting an alert into an opportunity, through the real route.
  //
  // This step exists because of a specific failure. `pnpm seed` writes to the
  // store directly and never calls an HTTP route, so it stayed green while the
  // POST that the app itself uses rejected every request: four id fields
  // asserted `z.string().uuid()` and nothing in this system has ever minted a
  // UUID. The first step of the demo script 400'd on the deployed runtime and
  // no script noticed, because no script was driving a route.
  //
  // So it is driven from the page, exactly as a reviewer drives it - the button
  // builds the payload, the route validates it, the store writes it, and the
  // alert comes back carrying the opportunity it opened. Safe to repeat: the
  // document key is `opportunities/<propertyId>`, so a second conversion of the
  // same parcel writes the same document rather than opening a second deal.
  await page.goto(`${target}/alerts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const convert = page.getByRole("button", { name: "Convert to opportunity" }).first();
  await convert.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);

  const inPipelineBefore = await page.getByText("in pipeline", { exact: true }).count();
  const convertible = await convert.isVisible().catch(() => false);
  if (convertible) {
    await convert.click().catch(() => undefined);
    // The handler posts the opportunity, marks the alert read and reloads, so
    // wait for the badge count to move rather than for a fixed interval.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const now = await page.getByText("in pipeline", { exact: true }).count();
      if (now > inPipelineBefore) break;
      await page.waitForTimeout(1_000);
    }
  }
  const inPipelineAfter = await page.getByText("in pipeline", { exact: true }).count();
  check(
    "an alert converts to an opportunity through the real route",
    convertible && inPipelineAfter > inPipelineBefore,
    convertible
      ? `${inPipelineBefore} -> ${inPipelineAfter} alerts in pipeline`
      : "no unconverted alert on the feed to convert",
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
  //
  // Read off the opportunities themselves rather than off page text. Counting
  // occurrences of each stage NAME on the page passes on a completely empty
  // board, because the stage filter's own dropdown lists every stage whether or
  // not a deal is in it - an assertion the wrong state also satisfies.
  const opportunities = await page.request
    .get(`${target}/api/opportunities`)
    .then((r) => r.json() as Promise<{ opportunities?: { opportunity?: { stage?: string } }[] }>)
    .catch(() => ({ opportunities: [] }));
  const stages = new Set(
    (opportunities.opportunities ?? [])
      .map((row) => row.opportunity?.stage)
      .filter((stage): stage is string => Boolean(stage)),
  );
  check(
    "deals are spread across the funnel",
    stages.size >= 3,
    `${stages.size} stages occupied: ${[...stages].join(", ") || "none"}`,
  );

  // 7a. And one of them opens.
  //
  // The board rendering is not the same claim as a deal being readable, and the
  // difference was a hard crash in production for a while: the page read
  // `detail.notes` while the API nested it inside `opportunity`, an unchecked
  // cast hid it from tsc, and 20 green smoke checks never opened a single
  // opportunity. Stage history, notes, tasks and the whole outreach thread live
  // behind this click.
  const firstDeal = page.getByRole("row").nth(1).getByRole("link").first();
  const dealHref = await firstDeal.getAttribute("href").catch(() => null);
  if (dealHref) {
    await page.goto(`${target}${dealHref}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  // Waited for rather than counted immediately: the deal page fetches its own
  // detail after mount, and reading the DOM before that lands says "missing"
  // about something that is merely late.
  const history = page.getByText(/stage history|no stage changes/i).first();
  await history.waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined);
  const crashed = await page
    .getByText(/couldn't load|something went wrong/i)
    .count()
    .catch(() => 0);
  const stageHistory = await history.count().catch(() => 0);
  check(
    "an opportunity opens with its activity",
    Boolean(dealHref) && crashed === 0 && stageHistory > 0,
    dealHref ? (crashed ? "the page crashed" : `${dealHref}`) : "no link to a deal",
  );

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

  // A rendered dropdown is not the same claim as a server that would answer.
  // The options could be stale bundle state; this asks the deployment whether a
  // key actually reached it and which models it will spend that key on.
  const agentStatus = await page.request
    .get(`${target}/api/agent`)
    .then((r) => r.json() as Promise<{ configured?: boolean; server_models?: unknown[] }>)
    .catch(() => ({}));
  check(
    "and the server confirms it holds a key for them",
    agentStatus.configured === true && (agentStatus.server_models?.length ?? 0) > 0,
    `configured=${String(agentStatus.configured)}, ${agentStatus.server_models?.length ?? 0} published`,
  );

  // 8. The store is attached and writable, which the header says out loud when
  //    it is not. Neither badge may be present on a correctly configured
  //    deployment.
  const readOnly = await page.getByText("Read only", { exact: true }).count();
  const ephemeral = await page.getByText("In-memory store", { exact: true }).count();
  check(
    "no warning badge about the store",
    readOnly === 0 && ephemeral === 0,
    readOnly ? "header says read only" : ephemeral ? "header says in-memory" : "no warning badge",
  );

  // The absence of a warning badge is not the presence of a store: a header that
  // failed to render says nothing at all and would satisfy the line above. Ask
  // the deployment directly what it is attached to.
  const status = await page.request
    .get(`${target}/api/datasource`)
    .then(
      (r) =>
        r.json() as Promise<{
          crmStore?: { kind?: string; writable?: boolean; ephemeral?: boolean };
        }>,
    )
    .catch(() => ({}));
  check(
    "the store is attached, durable and writable",
    status.crmStore?.writable === true && status.crmStore?.ephemeral === false,
    `${status.crmStore?.kind ?? "no store"}, writable=${String(status.crmStore?.writable)}`,
  );

  // 8b. The pipeline history the /pipeline page is built on.
  //
  // Checked for depth, not merely for presence: RUN_HISTORY_URL pointed at an
  // immutable CID still returns a valid history, and the page still renders -
  // it is simply frozen at the handful of runs that CID was pinned with, which
  // is the one thing a page about continuous refresh must not be. See
  // RUN_HISTORY_MIN.
  const runs = await page.request
    .get(`${target}/api/runs?limit=100`)
    .then((r) => r.json() as Promise<{ pipelineRuns?: unknown[]; matcherRuns?: unknown[] }>)
    .catch(() => ({}));
  check(
    "the published run history is the mutable one",
    (runs.pipelineRuns?.length ?? 0) >= RUN_HISTORY_MIN,
    `${runs.pipelineRuns?.length ?? 0} pipeline runs, floor ${RUN_HISTORY_MIN}`,
  );
  check(
    "and the matcher's own passes are recorded beside them",
    (runs.matcherRuns?.length ?? 0) > 0,
    `${runs.matcherRuns?.length ?? 0} passes`,
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
