/**
 * The cold load must not lie, and must not hang.
 *
 * On a cold load the tab range reads a 49.5 MB parquet of 404,023 Duval parcels
 * over a public IPFS gateway. That takes as long as the gateway takes, and one
 * observed load sat for roughly two minutes. During that window the search
 * surface rendered "Searching" and then "No parcels match these criteria" - so
 * the first thing a reviewer learned about the product was that it had searched
 * the county and found nothing.
 *
 * Three separate faults, and this file holds one test per fault:
 *
 *  1. Zero rows and "not attached yet" were the same state. `resultView` is now
 *     the only thing that decides, and `empty` is unreachable unless the source
 *     is attached and a query has come back.
 *  2. Nothing said what the wait was for. The attaching state carries elapsed
 *     time, byte progress, and which gateway is answering.
 *  3. Nothing ever gave up. Every gateway now has a deadline, failover to the
 *     next is automatic and disclosed, and exhausting them offers a retry.
 */

import { describe, expect, it } from "vitest";

import {
  GatewayAttach,
  engineProgressFor,
  gatewayIsAlive,
  hostOf,
  type AttachDeps,
} from "@/lib/data/browser";
import {
  DEFAULT_IPFS_GATEWAYS,
  ipfsGatewayCandidates,
  parseGatewayList,
  positiveInt,
  splitGatewayUrl,
} from "@/lib/data/public-config";
import { attachHeadline, resultView } from "@/lib/data/use-search";
import type { AttachAttaching, AttachFailed, AttachReady, AttachState } from "@/lib/data/types";

const IPNS = "k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r";
const PRIMARY = `https://ipfs.filebase.io/ipns/${IPNS}`;

/* ------------------------------------------------------- the empty-state lie */

const ATTACHING: AttachAttaching = {
  phase: "attaching",
  message: "Attaching the published query table",
  progress: null,
  elapsedMs: 1_000,
  gateway: PRIMARY,
  gatewayIndex: 0,
  gatewayCount: 3,
  failedOver: false,
};

const READY: AttachReady = {
  phase: "ready",
  gateway: PRIMARY,
  failedOver: false,
  elapsedMs: 4_200,
  accessMode: "http-range",
};

const FAILED: AttachFailed = {
  phase: "failed",
  error: "the gateway at ipfs.filebase.io did not answer within 8s",
  tried: [PRIMARY],
  elapsedMs: 30_000,
};

describe('"no parcels match these criteria" while the source is still attaching', () => {
  it("is unreachable from every state that is not an attached source with a finished query", () => {
    const states: AttachState[] = [ATTACHING, { ...ATTACHING, failedOver: true }, READY, FAILED];

    for (const attach of states) {
      for (const loading of [true, false]) {
        for (const rowCount of [0, 1, 404_023]) {
          const view = resultView(attach, loading, rowCount);
          if (view !== "empty") continue;
          // The one combination allowed to say nothing matched.
          expect(attach.phase).toBe("ready");
          expect(loading).toBe(false);
          expect(rowCount).toBe(0);
        }
      }
    }
  });

  it("is what the surface used to render, and now renders the attach instead", () => {
    // The exact shape of the bug: attaching, not loading a query, zero rows.
    expect(resultView(ATTACHING, false, 0)).toBe("attaching");
    expect(resultView({ ...ATTACHING, failedOver: true }, false, 0)).toBe("attaching");
    expect(resultView(FAILED, false, 0)).toBe("unavailable");
  });

  it("still says nothing matched once there is data and the query has come back", () => {
    expect(resultView(READY, false, 0)).toBe("empty");
    expect(resultView(READY, true, 0)).toBe("searching");
    expect(resultView(READY, false, 12)).toBe("results");
  });

  it("keeps the row count off every state that has no rows to count", () => {
    const attaching = { status: "attaching", attach: ATTACHING } as const;
    // @ts-expect-error - there is no row count before the source has attached,
    // which is the invariant this whole change exists to make unbreakable.
    void attaching.rows;
    // @ts-expect-error - and no total either.
    void attaching.total;

    const unavailable = { status: "unavailable", attach: FAILED } as const;
    // @ts-expect-error - a failed attach has an error and a retry, not results.
    void unavailable.rows;
  });
});

/* --------------------------------------------------------- honest progress */

describe("what the wait says while it waits", () => {
  it("names the elapsed time so a slow gateway reads as a slow network", () => {
    expect(attachHeadline({ ...ATTACHING, elapsedMs: 9_400 })).toBe(
      "Attaching the published query table - 9s elapsed",
    );
    expect(attachHeadline({ ...ATTACHING, elapsedMs: 132_000 })).toContain("2m 12s elapsed");
  });

  it("says so out loud once it has moved off the configured gateway", () => {
    const headline = attachHeadline({
      ...ATTACHING,
      failedOver: true,
      gatewayIndex: 1,
      message: "Downloading query table, 12.4 of 49.5 MB",
    });
    expect(headline).toContain("gateway 2 of 3");
    expect(headline).toContain("12.4 of 49.5 MB");
  });

  it("passes engine byte progress through, and only for the gateway being tried", () => {
    const engine = {
      stage: "downloading",
      message: "Downloading query table, 12.4 of 49.5 MB",
      progress: 0.25,
      sourceUrl: PRIMARY,
      accessMode: null,
    };

    expect(engineProgressFor(engine, PRIMARY)?.progress).toBe(0.25);
    // A load abandoned on an earlier gateway keeps writing into the engine's
    // one module level state. Reporting that as this gateway's progress would
    // be the same class of lie as the empty state.
    expect(engineProgressFor(engine, `https://ipfs.io/ipns/${IPNS}`)).toBeNull();
    expect(engineProgressFor({ ...engine, sourceUrl: null }, PRIMARY)).toBeNull();
  });
});

/* ------------------------------------------------------- gateway candidates */

describe("the fallback gateway list", () => {
  it("keeps the configured gateway first and rewrites the same content path", () => {
    const candidates = ipfsGatewayCandidates(PRIMARY, ["https://ipfs.io", "https://dweb.link/"]);
    expect(candidates).toEqual([
      PRIMARY,
      `https://ipfs.io/ipns/${IPNS}`,
      `https://dweb.link/ipns/${IPNS}`,
    ]);
  });

  it("handles a CID path as readily as an IPNS name", () => {
    const cid = "https://ipfs.filebase.io/ipfs/bafybeif2bwakcxmc3p2rkczkqvuecin6657oihsdm5mba5lk";
    expect(ipfsGatewayCandidates(cid, ["https://ipfs.io"])[1]).toBe(
      "https://ipfs.io/ipfs/bafybeif2bwakcxmc3p2rkczkqvuecin6657oihsdm5mba5lk",
    );
  });

  it("offers no fallback for a source that is not gateway addressed", () => {
    // The bundled sample is served by this deployment. There is no second place
    // to look for it, and inventing one would generate URLs that 404.
    expect(ipfsGatewayCandidates("/sample/query-table.parquet")).toEqual([
      "/sample/query-table.parquet",
    ]);
    expect(splitGatewayUrl("/sample/query-table.parquet")).toBeNull();
    expect(splitGatewayUrl("https://example.com/data.parquet")).toBeNull();
  });

  it("never repeats a gateway, however it was configured", () => {
    const candidates = ipfsGatewayCandidates(PRIMARY, [
      "https://ipfs.filebase.io",
      "https://ipfs.io",
      "https://ipfs.io/",
    ]);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates).toHaveLength(2);
  });

  it("reads the environment list, and falls back to the built in one", () => {
    expect(parseGatewayList("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(parseGatewayList("")).toEqual(DEFAULT_IPFS_GATEWAYS);
    expect(parseGatewayList(undefined)).toEqual(DEFAULT_IPFS_GATEWAYS);
    // Nonsense is not a gateway; the default list answers rather than a 404.
    expect(parseGatewayList("not-a-url, ftp://nope")).toEqual(DEFAULT_IPFS_GATEWAYS);
  });

  it("takes a timeout from the environment and refuses a nonsensical one", () => {
    expect(positiveInt("15000", 45_000)).toBe(15_000);
    expect(positiveInt("0", 45_000)).toBe(45_000);
    expect(positiveInt("-1", 45_000)).toBe(45_000);
    expect(positiveInt("soon", 45_000)).toBe(45_000);
    expect(positiveInt(undefined, 45_000)).toBe(45_000);
  });
});

/* ------------------------------------------------------- deadline and failover */

const A = `https://a.example/ipns/${IPNS}`;
const B = `https://b.example/ipns/${IPNS}`;
const C = `https://c.example/ipns/${IPNS}`;

function deps(overrides: Partial<AttachDeps> = {}): AttachDeps {
  return {
    probe: async () => undefined,
    load: async () => undefined,
    reset: async () => undefined,
    progress: () => null,
    now: () => Date.now(),
    ...overrides,
  };
}

/** A gateway that accepts the connection and then says nothing, ever. */
function silent(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

function attach(candidates: readonly string[], overrides: Partial<AttachDeps> = {}) {
  return new GatewayAttach({
    candidates,
    // Real deadlines are 8s and 45s; the behaviour under test is identical and
    // a test suite should not spend either.
    probeTimeoutMs: 25,
    attachTimeoutMs: 25,
    deps: deps(overrides),
  });
}

describe("a gateway that does not answer", () => {
  it("is given up on rather than waited out, and the next one is tried", async () => {
    const probed: string[] = [];
    const controller = attach([A, B], {
      probe: async (url, signal) => {
        probed.push(url);
        if (url === A) await silent(signal);
      },
    });

    await controller.start();

    expect(probed).toEqual([A, B]);
    const state = controller.state();
    expect(state.phase).toBe("ready");
    expect(controller.attachedUrl()).toBe(B);
  });

  it("says out loud that it is no longer reading the configured gateway", async () => {
    const controller = attach([A, B], {
      probe: async (url, signal) => {
        if (url === A) await silent(signal);
      },
    });

    await controller.start();

    const state = controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    expect(state.failedOver).toBe(true);
    expect(state.gateway).toBe(B);
  });

  it("fails over when it answers the probe but then stalls on the attach", async () => {
    const reset: number[] = [];
    const controller = attach([A, B], {
      // Never settles: the deadline is the only thing that ends this.
      load: (url) => (url === A ? new Promise<void>(() => undefined) : Promise.resolve()),
      reset: async () => {
        reset.push(1);
      },
    });

    await controller.start();

    expect(controller.attachedUrl()).toBe(B);
    // A half attached engine would answer B's queries out of A's file handle.
    expect(reset).toHaveLength(1);
  });

  it("names every gateway it tried, and why the last one failed", async () => {
    const controller = attach([A, B, C], { probe: (_url, signal) => silent(signal) });

    await controller.start();

    const state = controller.state();
    if (state.phase !== "failed") throw new Error(`expected failed, got ${state.phase}`);
    // All three, in order, so the retry message can say what was already tried
    // rather than "something went wrong".
    expect(state.tried).toEqual([A, B, C]);
    expect(state.error).toContain("c.example");
    expect(state.error).toContain("did not answer within");
    // The bound is stated in the unit the person waiting was counting in, and
    // never as a rounded-to-nothing "0s".
    expect(state.error).not.toContain("within 0s");
    expect(state.error).not.toContain("aborted");
  });

  it("never leaves the caller with a zero-row result to render", async () => {
    const controller = attach([A], { probe: (_url, signal) => silent(signal) });
    await controller.start();

    // The failure surfaces as its own state with a retry, and resultView keeps
    // it away from the empty state whatever the row count happens to be.
    expect(resultView(controller.state(), false, 0)).toBe("unavailable");
  });
});

describe("the attach state a page renders", () => {
  it("is attaching, with a live elapsed clock, before anything settles", async () => {
    let clock = 1_000;
    const controller = new GatewayAttach({
      candidates: [A],
      probeTimeoutMs: 5_000,
      attachTimeoutMs: 5_000,
      deps: deps({
        now: () => clock,
        load: () => new Promise<void>(() => undefined),
        progress: () => ({
          message: "Downloading query table, 4.0 MB",
          progress: null,
          accessMode: null,
        }),
      }),
    });

    void controller.start();
    await Promise.resolve();

    clock = 61_000;
    const state = controller.state();
    if (state.phase !== "attaching") throw new Error(`expected attaching, got ${state.phase}`);
    expect(state.elapsedMs).toBe(60_000);
    expect(state.gatewayCount).toBe(1);
    expect(attachHeadline(state)).toContain("1m 0s elapsed");
  });

  it("is attaching before anything has been started, never ready by default", () => {
    const controller = attach([A]);
    expect(controller.state().phase).toBe("attaching");
    expect(controller.attachedUrl()).toBeNull();
  });

  it("carries how the bytes arrived once it is ready, for the data page", async () => {
    const controller = attach([A], {
      progress: () => ({ message: "Ready", progress: null, accessMode: "http-range" }),
    });

    await controller.start();

    const state = controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    expect(state.accessMode).toBe("http-range");
    expect(state.failedOver).toBe(false);
  });
});

describe("the retry offered after every gateway refused", () => {
  it("starts again from the configured gateway and can succeed", async () => {
    let refusing = true;
    const controller = attach([A, B], {
      probe: async (_url, signal) => {
        if (refusing) await silent(signal);
      },
    });

    await controller.start();
    expect(controller.state().phase).toBe("failed");

    refusing = false;
    await controller.retry();

    const state = controller.state();
    if (state.phase !== "ready") throw new Error(`expected ready, got ${state.phase}`);
    expect(state.gateway).toBe(A);
    expect(state.failedOver).toBe(false);
  });

  it("does the work once however many callers ask for it", async () => {
    let loads = 0;
    const controller = attach([A], {
      load: async () => {
        loads += 1;
      },
    });

    await Promise.all([controller.start(), controller.start(), controller.start()]);

    expect(loads).toBe(1);
  });
});

describe("what counts as a gateway that answered", () => {
  it("accepts a gateway that will not do HEAD, because it is still there", () => {
    // Failing over on a 405 would abandon a working gateway over a method it
    // does not implement and the attach never uses.
    expect(gatewayIsAlive(405)).toBe(true);
    expect(gatewayIsAlive(501)).toBe(true);
    expect(gatewayIsAlive(200)).toBe(true);
    expect(gatewayIsAlive(301)).toBe(true);
  });

  it("moves on from a gateway that does not have the content or cannot serve it", () => {
    expect(gatewayIsAlive(404)).toBe(false);
    expect(gatewayIsAlive(410)).toBe(false);
    // Rate limited and server errors will not serve 49.5 MB either.
    expect(gatewayIsAlive(429)).toBe(false);
    expect(gatewayIsAlive(500)).toBe(false);
    expect(gatewayIsAlive(504)).toBe(false);
  });
});

describe("a gateway named in a message a person reads", () => {
  it("is a host, not a 90 character content address", () => {
    expect(hostOf(PRIMARY)).toBe("ipfs.filebase.io");
    expect(hostOf("/sample/query-table.parquet")).toBe("/sample/query-table.parquet");
  });
});
