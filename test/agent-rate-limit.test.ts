/**
 * The agent's budget has to be counted in the unit its refusal names.
 *
 * The defect was a mismatch, not a missing limit. `/api/llm/<provider>` counts
 * MODEL CALLS - it is a per-call proxy, so that is the only thing it can see -
 * and the budget was fifteen per ten minutes, carried over from a repository
 * where one question was one call. Here a question is a tool loop of up to
 * `MAX_STEPS` calls, so fifteen was 1.25 questions, and the 429 told the visitor
 * they had used fifteen questions. Both halves were wrong at once: the budget
 * was unusable and the reason given for it was false.
 *
 * These pin the fix from both ends. The budget has to buy a realistic number of
 * whole questions, and every number in the refusal has to be the number that was
 * actually counted.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_QUESTION_BUDGET,
  AGENT_RATE_LIMIT,
  AGENT_STEPS_PER_QUESTION,
  RateLimiter,
  agentModelCallBudget,
  modelCallLimitMessage,
} from "@/lib/agent/ratelimit";

const ROOT = resolve(__dirname, "..");

/** A fixture environment. NODE_ENV is required on ProcessEnv and irrelevant here. */
const makeEnv = (values: Record<string, string>): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...values }) as NodeJS.ProcessEnv;

/** Spend one question's worth of the budget, the way the loop does. */
function askOneQuestion(limiter: RateLimiter, steps = AGENT_STEPS_PER_QUESTION) {
  const decisions = [];
  for (let step = 0; step < steps; step += 1) decisions.push(limiter.check("203.0.113.7"));
  return decisions;
}

describe("what a question costs", () => {
  it("agrees with the tool loop's own step ceiling", () => {
    // The ceiling lives in lib/agent/client-run.ts, which is a "use client"
    // module a server route must not import (test/client-boundary.test.ts).
    // Read rather than imported, so the two cannot drift apart in silence.
    const source = readFileSync(resolve(ROOT, "lib/agent/client-run.ts"), "utf8");
    const declared = /export const MAX_STEPS = (\d+)/.exec(source)?.[1];

    expect(declared).toBeDefined();
    expect(Number(declared)).toBe(AGENT_STEPS_PER_QUESTION);
  });
});

describe("the model call budget", () => {
  it("is a whole number of full-depth questions, not a raw call count", () => {
    expect(agentModelCallBudget(makeEnv({}))).toBe(
      AGENT_QUESTION_BUDGET * AGENT_STEPS_PER_QUESTION,
    );
  });

  it("lets a reviewer ask the advertised number of questions without a refusal", () => {
    const limiter = new RateLimiter({
      limit: agentModelCallBudget(makeEnv({})),
      windowMs: 600_000,
    });

    for (let question = 0; question < AGENT_QUESTION_BUDGET; question += 1) {
      const refused = askOneQuestion(limiter).filter((decision) => !decision.allowed);
      expect(refused).toEqual([]);
    }

    // And the very next call is refused, so this is a real cap rather than none.
    expect(limiter.check("203.0.113.7").allowed).toBe(false);
  });

  it("refuses the second question under the budget that shipped", () => {
    // The pre-fix number. One question spends twelve of the fifteen, so the
    // refusal lands part way through the second answer.
    const limiter = new RateLimiter({ limit: 15, windowMs: 600_000 });

    expect(askOneQuestion(limiter).filter((decision) => !decision.allowed)).toEqual([]);
    expect(askOneQuestion(limiter).some((decision) => !decision.allowed)).toBe(true);
  });

  it("still honours an operator's explicit call ceiling", () => {
    expect(agentModelCallBudget(makeEnv({ AGENT_RATE_LIMIT: "40" }))).toBe(40);
    expect(agentModelCallBudget(makeEnv({ AGENT_QUESTION_BUDGET: "3" }))).toBe(
      3 * AGENT_STEPS_PER_QUESTION,
    );
  });

  it("is the budget the proxy route actually holds", () => {
    // The vendored module exports an AGENT_RATE_LIMIT of fifteen; this one
    // shadows it. A star re-export that quietly won would put the old cap back
    // on the deployed route with every test here still green.
    expect(AGENT_RATE_LIMIT.check("198.51.100.4").limit).toBe(
      AGENT_QUESTION_BUDGET * AGENT_STEPS_PER_QUESTION,
    );
  });
});

describe("the reason given with a 429", () => {
  const decision = { allowed: false, remaining: 0, retryAfterSeconds: 240, limit: 144 };

  it("names model calls, because model calls are what was counted", () => {
    const message = modelCallLimitMessage(decision, 600_000);

    expect(message).toContain("144 model calls per 10 minutes");
    expect(message).toContain("240s");
  });

  it("says how many questions that is, and says it truthfully", () => {
    const message = modelCallLimitMessage(decision, 600_000);

    expect(message).toContain(`up to ${AGENT_STEPS_PER_QUESTION} model calls`);
    expect(message).toContain(`at least ${Math.floor(144 / AGENT_STEPS_PER_QUESTION)} questions`);
  });

  it("never claims a question count the budget cannot pay for", () => {
    // The exact shape of the old lie: a budget of fifteen calls described as
    // fifteen questions. Fifteen calls is one question and a fragment, and that
    // is what the sentence now says.
    const fifteen = modelCallLimitMessage(
      { allowed: false, remaining: 0, retryAfterSeconds: 30, limit: 15 },
      600_000,
    );
    expect(fifteen).not.toMatch(/\b15 questions\b/);
    expect(fifteen).toContain("at least 1 question of the deepest kind");

    // And a budget too small for even one says so rather than rounding to zero.
    const tiny = modelCallLimitMessage(
      { allowed: false, remaining: 0, retryAfterSeconds: 30, limit: 8 },
      600_000,
    );
    expect(tiny).toContain("less than one full-depth question");
  });
});
