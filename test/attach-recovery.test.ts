/**
 * A bad gateway day must not be a broken product.
 *
 * A reviewer driving the deployed app watched all three configured IPFS
 * gateways fail inside one session and had to press retry by hand. Everything
 * the previous round added - deadlines, failover, a visible retry - was working
 * exactly as designed. The design was the problem: it could tell the truth
 * about a failure and it could stop waiting, but it could not *recover*.
 *
 * Four recoveries are tested here, in the order the controller reaches for
 * them, plus the two facts that make the last one possible at all:
 *
 *  1. A gateway that refuses is asked again after a backoff, rather than being
 *     written off for the session on one bad response.
 *  2. A gateway that goes silent is NOT asked again, because it already spent
 *     the whole deadline proving nothing, and a five gateway list cannot afford
 *     to spend every deadline twice.
 *  3. When the list is exhausted it is swept again, not abandoned.
 *  4. When that fails too, this browser's own copy is attached with no network
 *     at all - which is the one that lets a demo machine open the app with
 *     every gateway on earth refusing - and the state says so out loud.
 *
 * And underneath: the cache is keyed on the CONTENT a URL addresses rather than
 * the gateway that served it, so a copy taken from one gateway is found when
 * another is being asked about, and a cached copy is found with no network at
 * all rather than needing a HEAD to name its own version.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  GatewayAttach,
  backoffFor,
  cachedLocationLabel,
  contentRangeTotal,
  exhaustedMessage,
  rangeProbeVerdict,
  type AttachDeps,
} from "@/lib/data/browser";
import {
  ARTIFACT_MIN_BYTES,
  DEFAULT_IPFS_GATEWAYS,
  applyGateway,
  envFlag,
  ipfsGatewayCandidates,
  parseGatewayList,
  splitGatewayUrl,
} from "@/lib/data/public-config";
import { cacheClear, cacheGet, cacheLookup, cachePut, contentAddressOf } from "@/lib/oracle/opfs";
import { resultView } from "@/lib/data/use-search";
import type { AttachAttaching, CachedArtifactInfo } from "@/lib/data/types";

const IPNS = "k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r";
const A = `https://a.example/ipns/${IPNS}`;
const B = `https://b.example/ipns/${IPNS}`;
const C = `https://c.example/ipns/${IPNS}`;

const CACHED: CachedArtifactInfo = {
  sourceUrl: A,
  bytes: 49_974_055,
  cachedAt: "2026-08-21T09:14:00.000Z",
  version: "bafyroot",
};

interface Harness {
  controller: GatewayAttach;
  probed: string[];
  slept: number[];
  resets: number;
  precached: string[];
}

/**
 * A controller wired to a fake network, a fake engine and a fake clock.
 *
 * Nothing here waits: `sleep` records the backoff it was asked for and returns,
 * and `now` runs off a counter the test moves. The behaviour under test is
 * identical to production's 8s / 45s / 120s and a test suite should not spend
 * any of it.
 */
function harness(
  candidates: readonly string[],
  overrides: Partial<AttachDeps> = {},
  options: Partial<{
    attemptsPerGateway: number;
    passes: number;
    retryBackoffMs: number;
    budgetMs: number;
    clock: () => number;
  }> = {},
): Harness {
  const probed: string[] = [];
  const slept: number[] = [];
  const state = { resets: 0 };
  const precached: string[] = [];

  const { probe: probeOverride, ...rest } = overrides;

  const deps: AttachDeps = {
    load: async () => undefined,
    reset: async () => {
      state.resets += 1;
    },
    progress: () => null,
    now: options.clock ?? (() => 0),
    sleep: async (ms) => {
      slept.push(ms);
    },
    precache: (url) => {
      precached.push(url);
    },
    ...rest,
    // Wrapped rather than replaced, so every test can assert what was asked of
    // which gateway without repeating the bookkeeping.
    probe: async (url, signal) => {
      probed.push(url);
      await probeOverride?.(url, signal);
    },
  };

  const controller = new GatewayAttach({
    candidates,
    probeTimeoutMs: 25,
    attachTimeoutMs: 25,
    attemptsPerGateway: options.attemptsPerGateway ?? 2,
    passes: options.passes ?? 2,
    retryBackoffMs: options.retryBackoffMs ?? 750,
    budgetMs: options.budgetMs ?? 120_000,
    deps,
  });

  return {
    controller,
    probed,
    slept,
    precached,
    get resets() {
      return state.resets;
    },
  };
}

/** A gateway that accepts the connection and then says nothing, ever. */
function silent(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

/* --------------------------------------------------- 1. retry, then succeed */

describe("a gateway that refuses once", () => {
  it("is asked again after a backoff rather than written off for the session", async () => {
    let refusals = 0;
    const rig = harness([A, B], {
      probe: async (url) => {
        if (url !== A) return;
        refusals += 1;
        if (refusals === 1) throw new Error("a.example answered 502 Bad Gateway");
      },
    });

    await rig.controller.start();

    const state = rig.controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    // The configured gateway, on its second ask. Failing over to B here would
    // have been the wrong answer twice: a worse gateway, and a lost recovery.
    expect(state.gateway).toBe(A);
    expect(refusals).toBe(2);
    expect(rig.slept).toEqual([750]);
    // The half attached engine is still torn down between asks, or the retry
    // would answer out of the failed attempt's file handle.
    expect(rig.resets).toBe(1);
  });

  it("gives up on it after the configured number of asks and moves on", async () => {
    const rig = harness(
      [A, B],
      {
        probe: async (url) => {
          if (url === A) throw new Error("a.example answered 429 Too Many Requests");
        },
      },
      { attemptsPerGateway: 3, retryBackoffMs: 100 },
    );

    await rig.controller.start();

    expect(rig.probed).toEqual([A, A, A, B]);
    // Doubling, so a gateway under load is not hammered on a fixed interval.
    expect(rig.slept).toEqual([100, 200]);
    expect(rig.controller.attachedUrl()).toBe(B);
  });

  it("says which attempt it is on, so a retry is visible rather than a longer wait", async () => {
    let asked = 0;
    const rig = harness([A], {
      probe: async () => {
        asked += 1;
        if (asked === 1) throw new Error("a.example answered 503 Service Unavailable");
        await silent();
      },
    });

    void rig.controller.start();
    // Let the first refusal, the reset and the backoff settle.
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();

    const state: AttachAttaching = rig.controller.state() as AttachAttaching;
    expect(state.phase).toBe("attaching");
    expect(state.message).toBe("Retrying a.example (attempt 2 of 2)");
  });

  it("backs off exponentially and then stops growing", () => {
    expect(backoffFor(750, 1)).toBe(750);
    expect(backoffFor(750, 2)).toBe(1_500);
    expect(backoffFor(750, 4)).toBe(6_000);
    // Capped, so a long list cannot turn a backoff into an outage of its own.
    expect(backoffFor(750, 9)).toBe(6_000);
  });
});

/* ------------------------------------------- 2. silence is not worth a retry */

describe("a gateway that goes silent", () => {
  it("is not asked a second time, because it already spent the whole deadline", async () => {
    const rig = harness([A, B], { probe: (_url, signal) => silent(signal) });

    await rig.controller.start();

    // Two passes over two candidates, one ask each. Retrying a timeout would
    // make that eight deadlines instead of four for exactly the same silence.
    expect(rig.probed).toEqual([A, B, A, B]);
    expect(rig.slept).toEqual([]);
  });
});

/* -------------------------------------------- 3. round the list a second time */

describe("a gateway list that has been exhausted", () => {
  it("is swept again rather than abandoned, and an earlier candidate can recover", async () => {
    let sweep = 0;
    const rig = harness([A, B], {
      probe: async (url, signal) => {
        if (url === A) sweep += 1;
        // Both refuse for the whole first pass; A is answering again by the
        // second, which is exactly what a public gateway's bad minute looks
        // like from the outside.
        if (sweep <= 1) await silent(signal);
      },
    });

    await rig.controller.start();

    const state = rig.controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    expect(state.gateway).toBe(A);
    // It came back to the configured gateway, and says it had left it.
    expect(state.failedOver).toBe(true);
  });

  it("stops sweeping once the wall clock budget is spent", async () => {
    let clock = 0;
    const rig = harness(
      [A, B, C],
      {
        probe: async (_url, signal) => {
          clock += 8_000;
          await silent(signal);
        },
      },
      { passes: 4, budgetMs: 20_000, clock: () => clock },
    );

    await rig.controller.start();

    // Three eight second probes puts the clock past twenty, so the fourth
    // attempt never starts. Without the budget this would have been twelve.
    expect(rig.probed).toEqual([A, B, C]);
    expect(rig.controller.state().phase).toBe("failed");
  });
});

/* ------------------------------------------------- 4. the cache actually saves */

describe("every gateway failing, on a machine that has loaded the artifact before", () => {
  it("serves the cached copy instead of a retry button", async () => {
    const rig = harness([A, B], {
      probe: (_url, signal) => silent(signal),
      attachCached: async () => CACHED,
    });

    await rig.controller.start();

    const state = rig.controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    expect(state.accessMode).toBe("cached");
    expect(state.cached).toEqual(CACHED);
    expect(rig.controller.attachedUrl()).toBe(A);
    // And the surface renders results rather than the unavailable panel.
    expect(resultView(state, false, 404_023)).toBe("results");
  });

  it("does not go looking for the cache before the gateways have had a go", async () => {
    let looked = 0;
    const rig = harness([A], {
      attachCached: async () => {
        looked += 1;
        return CACHED;
      },
    });

    await rig.controller.start();

    const state = rig.controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    // A healthy gateway holding this morning's publish beats a cached copy of
    // last week's every time. The cache is a fallback, not a shortcut.
    expect(looked).toBe(0);
    expect(state.cached).toBeNull();
    expect(state.gateway).toBe(A);
  });

  it("asks the cache once, and keeps sweeping when there is nothing in it", async () => {
    let looked = 0;
    const rig = harness([A], {
      probe: (_url, signal) => silent(signal),
      attachCached: async () => {
        looked += 1;
        return null;
      },
    });

    await rig.controller.start();

    // A cache miss does not become a hit by asking again.
    expect(looked).toBe(1);
    expect(rig.probed).toEqual([A, A]);
    expect(rig.controller.state().phase).toBe("failed");
  });

  it("tops the cache up after a live load, so the NEXT outage is survivable", async () => {
    const rig = harness([A]);

    await rig.controller.start();

    // A range read touches a few hundred kilobytes of a 49.5 MB file. Without
    // this one deliberate whole-object fetch there is nothing on disk to fall
    // back to, and the fallback above never fires for anybody.
    expect(rig.precached).toEqual([A]);
  });

  it("says out loud that it is serving a cached artifact, and when it was taken", () => {
    const label = cachedLocationLabel(CACHED);
    expect(label).toContain("cached copy");
    expect(label).toContain("47.7 MB");
    expect(label).toContain("2026-08-21 09:14:00");
    expect(label).toContain("no gateway reachable");
  });
});

/* ------------------------------------------ 5. a terminal state worth reading */

describe("everything failing, on a machine with no cached copy", () => {
  it("names every gateway, what each one did, and what to do about it", async () => {
    const rig = harness(
      [A, B, C],
      {
        probe: async (url, signal) => {
          if (url === B) throw new Error("b.example answered 429 Too Many Requests");
          await silent(signal);
        },
      },
      { retryBackoffMs: 10 },
    );

    await rig.controller.start();

    const state = rig.controller.state();
    if (state.phase !== "failed") throw new Error(`expected failed, got ${state.phase}`);

    expect(state.tried).toEqual([A, B, C]);
    expect(state.attempts).toEqual([
      { url: A, tries: 2, error: expect.stringContaining("did not answer within"), timedOut: true },
      { url: B, tries: 4, error: "b.example answered 429 Too Many Requests", timedOut: false },
      { url: C, tries: 2, error: expect.stringContaining("did not answer within"), timedOut: true },
    ]);

    // The reader needs to be able to tell a gateway that timed out from one
    // that rate limited us, because those have different answers.
    expect(state.error).toContain("a.example - the gateway at a.example did not answer within");
    expect(state.error).toContain("b.example answered 429 Too Many Requests (asked 4 times)");
    expect(state.error).toContain("no cached copy");
    expect(state.error).toContain("NEXT_PUBLIC_IPFS_GATEWAYS");
    expect(state.error).not.toContain("aborted");
  });

  it("says so plainly when there was nothing configured to try", async () => {
    const rig = harness([]);
    await rig.controller.start();

    const state = rig.controller.state();
    if (state.phase !== "failed") throw new Error(`expected failed, got ${state.phase}`);
    expect(state.error).toBe("no gateway was configured");
    expect(state.tried).toEqual([]);
  });

  it("still keeps the empty result state unreachable while it is failing", async () => {
    const rig = harness([A], { probe: (_url, signal) => silent(signal) });
    await rig.controller.start();
    expect(resultView(rig.controller.state(), false, 0)).toBe("unavailable");
  });

  it("reads as one sentence even for a single gateway", () => {
    const message = exhaustedMessage(
      [{ url: A, tries: 1, error: "a.example answered 500", timedOut: false }],
      1,
      31_000,
    );
    expect(message).toContain("Tried 1 gateway in 31s");
    expect(message).not.toContain("passes");
    expect(message).not.toContain("asked 1 times");
  });
});

/* ------------------------------- 6. the cache is content addressed, not gateway */

describe("the cached artifact", () => {
  beforeEach(async () => {
    await cacheClear();
  });

  it("is one entry per artifact, whichever gateway the bytes came from", () => {
    // Path form and subdomain form address the same object, and the old key
    // treated them as three unrelated 49.5 MB downloads.
    expect(contentAddressOf(`https://ipfs.io/ipns/${IPNS}`)).toBe(`ipns/${IPNS}`);
    expect(contentAddressOf(`https://ipfs.filebase.io/ipns/${IPNS}`)).toBe(`ipns/${IPNS}`);
    expect(contentAddressOf(`https://${IPNS}.ipns.dweb.link/`)).toBe(`ipns/${IPNS}`);
    expect(contentAddressOf(`https://ipfs.io/ipns/${IPNS}/query-table.parquet`)).toBe(
      `ipns/${IPNS}/query-table.parquet`,
    );
    // A CID is a different object from an IPNS name pointing at it, and the
    // bundled sample is not gateway addressed at all.
    expect(contentAddressOf("https://ipfs.io/ipfs/bafyroot")).toBe("ipfs/bafyroot");
    expect(contentAddressOf("/sample/query-table.parquet")).toBe("/sample/query-table.parquet");
  });

  it("is found on the second load, through a different gateway than wrote it", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // First load: ipfs.io answered and the copy was taken from it.
    await cachePut(`https://ipfs.io/ipns/${IPNS}`, "bafyroot", bytes);

    // Second load: the configured Filebase URL leads, and finds it.
    const found = await cacheLookup(`https://ipfs.filebase.io/ipns/${IPNS}`);
    expect(found?.data).toEqual(bytes);
    expect(found?.version).toBe("bafyroot");
    expect(found?.sourceUrl).toBe(`https://ipfs.io/ipns/${IPNS}`);
    // Even the subdomain form, which is not a prefix rewrite of either.
    expect((await cacheLookup(`https://${IPNS}.ipns.dweb.link/`))?.data).toEqual(bytes);
  });

  it("is found with no network at all, which is the whole point of it", async () => {
    await cachePut(A, "bafyroot", new Uint8Array([9]));
    // The old lookup needed a version, and the only way to learn a version was
    // a HEAD against a gateway - so the cache was unreachable in exactly the
    // situation it existed for.
    expect(await cacheLookup(A)).not.toBeNull();
  });

  it("is not served as fresh when the gateway is holding a newer publish", async () => {
    await cachePut(A, "last-week", new Uint8Array([9]));
    // The strict read the engine takes on a normal load: a copy of last week's
    // artifact must not be served while a gateway offers this week's.
    expect(await cacheGet(A, "this-week")).toBeNull();
    expect(await cacheGet(A, "last-week")).not.toBeNull();
    // The relaxed read still finds it, for the case where nothing is offering
    // anything at all - and the caller has to label what it serves.
    expect((await cacheLookup(A))?.version).toBe("last-week");
  });

  it("reports nothing when nothing has been cached", async () => {
    expect(await cacheLookup(C)).toBeNull();
    expect(await cacheGet(C, null)).toBeNull();
  });
});

/* ------------------------------------------- 7. gateways that can actually serve */

describe("the gateways this deployment will try", () => {
  it("no longer includes the dweb.link path form, which cannot work in a browser", () => {
    // https://dweb.link/ipns/<name> answers a CORS preflight with a 301, and a
    // redirected preflight is a hard failure by specification: the browser
    // never sends the ranged request. It passed the old HEAD probe happily.
    expect(DEFAULT_IPFS_GATEWAYS).not.toContain("https://dweb.link");
    const candidates = ipfsGatewayCandidates(
      `https://ipfs.filebase.io/ipns/${IPNS}`,
      DEFAULT_IPFS_GATEWAYS,
    );
    expect(candidates.some((url) => url.startsWith("https://dweb.link/"))).toBe(false);
  });

  it("addresses dweb.link by its subdomain form, which serves the bytes with no hop", () => {
    const candidates = ipfsGatewayCandidates(
      `https://ipfs.filebase.io/ipns/${IPNS}`,
      DEFAULT_IPFS_GATEWAYS,
    );
    expect(candidates).toEqual([
      `https://ipfs.filebase.io/ipns/${IPNS}`,
      `https://ipfs.io/ipns/${IPNS}`,
      `https://${IPNS}.ipns.dweb.link/`,
    ]);
  });

  it("carries a path under the artifact through both gateway shapes", () => {
    const parts = splitGatewayUrl(`https://ipfs.filebase.io/ipns/${IPNS}/query-table.parquet`);
    expect(parts).toMatchObject({ namespace: "ipns", id: IPNS, suffix: "/query-table.parquet" });
    expect(applyGateway("https://ipfs.io", parts!)).toBe(
      `https://ipfs.io/ipns/${IPNS}/query-table.parquet`,
    );
    expect(applyGateway("https://{id}.{ns}.dweb.link", parts!)).toBe(
      `https://${IPNS}.ipns.dweb.link/query-table.parquet`,
    );
  });

  it("declines the subdomain form for an identifier that cannot be a DNS label", () => {
    // A CIDv0 is case sensitive base58; DNS labels are not case sensitive, so
    // there is no subdomain spelling of one and inventing it would 404.
    const parts = splitGatewayUrl("https://ipfs.io/ipfs/QmSomeCidV0Address");
    expect(applyGateway("https://{id}.{ns}.dweb.link", parts!)).toBeNull();
    expect(applyGateway("https://ipfs.io", parts!)).toBe("https://ipfs.io/ipfs/QmSomeCidV0Address");
    // And the path form of a base32 CID is still a plain rewrite.
    expect(
      ipfsGatewayCandidates("https://ipfs.io/ipfs/bafyroot", ["https://{id}.{ns}.dweb.link"])[1],
    ).toBe("https://bafyroot.ipfs.dweb.link/");
  });

  it("reads a template out of the environment list like any other gateway", () => {
    expect(parseGatewayList("https://ipfs.io, https://{id}.{ns}.dweb.link")).toEqual([
      "https://ipfs.io",
      "https://{id}.{ns}.dweb.link",
    ]);
  });
});

describe("what a gateway has to prove before the engine is handed it", () => {
  it("passes a gateway that answers 206 with a plausible object size", () => {
    const verdict = rangeProbeVerdict(206, "bytes 0-0/49974055", ARTIFACT_MIN_BYTES);
    expect(verdict).toMatchObject({ ok: true, ranged: true, totalBytes: 49_974_055 });
  });

  it("rejects a gateway that answers 206 with an error page", () => {
    // gw3.io does exactly this: 206, content-range total 965, for a 49.5 MB
    // parquet. The old probe would have handed it to DuckDB and spent the whole
    // attach deadline discovering it was not a parquet.
    const verdict = rangeProbeVerdict(206, "bytes 0-99/965", ARTIFACT_MIN_BYTES);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("too small to be the query table");
  });

  it("still passes a gateway that ignores the range, because downloading works", () => {
    const verdict = rangeProbeVerdict(200, null, ARTIFACT_MIN_BYTES);
    expect(verdict).toMatchObject({ ok: true, ranged: false });
    expect(verdict.reason).toContain("whole object will be downloaded");
  });

  it("moves on from a gateway that does not have the content or is rate limiting", () => {
    expect(rangeProbeVerdict(404, null, ARTIFACT_MIN_BYTES).ok).toBe(false);
    expect(rangeProbeVerdict(429, null, ARTIFACT_MIN_BYTES).ok).toBe(false);
    expect(rangeProbeVerdict(503, null, ARTIFACT_MIN_BYTES).reason).toBe("answered 503");
  });

  it("reads the object size out of a content-range header, or admits it cannot", () => {
    expect(contentRangeTotal("bytes 0-0/49974055")).toBe(49_974_055);
    expect(contentRangeTotal("bytes 0-0/*")).toBeNull();
    expect(contentRangeTotal(null)).toBeNull();
    // Unknown total: accepted rather than guessed at.
    expect(rangeProbeVerdict(206, "bytes 0-0/*", ARTIFACT_MIN_BYTES).ok).toBe(true);
  });
});

describe("the switches an operator gets", () => {
  it("turns a default-on feature off only for a value that means off", () => {
    expect(envFlag(undefined, true)).toBe(true);
    expect(envFlag("", true)).toBe(true);
    expect(envFlag("0", true)).toBe(false);
    expect(envFlag("false", true)).toBe(false);
    expect(envFlag("OFF", true)).toBe(false);
    expect(envFlag("1", false)).toBe(true);
  });
});

/* ---------------------------------------------------- the invariant, still held */

describe("the type level invariant this whole area exists to protect", () => {
  it("keeps a cached artifact off every state that is not attached", () => {
    const attaching = { phase: "attaching", gateway: A } as const;
    // @ts-expect-error - "attaching" carries no artifact, cached or otherwise,
    // so nothing can render a dataset before there is one.
    void attaching.cached;

    const failed = { phase: "failed", error: "none answered" } as const;
    // @ts-expect-error - and a failed attach has attempts and a retry, not data.
    void failed.cached;
  });
});
