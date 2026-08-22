// Re-export of the vendored module. See lib/oracle/VENDORED.md.
// This file exists so route and loop code can import from "@/lib/agent/*"
// whether a module is shared with the pipeline repository or written here.
//
// The sibling re-exports are one `export *` line. This one is not, and the
// difference is deliberate: `AGENT_RATE_LIMIT` is declared HERE, because the
// vendored budget was sized for a repository where one question was one model
// call and here it is not. A local export does win over a star export by the
// language's own rules, but the consequence of a bundler disagreeing would be
// the old fifteen-call cap silently back on the deployed route, so the vendored
// names are listed one by one and the shadowed one simply is not among them.

import { RateLimiter, type RateLimitDecision } from "@/lib/oracle/agent/ratelimit";

export {
  RateLimiter,
  TEST_RATE_LIMIT,
  clientAddress,
  type RateLimitDecision,
  type RateLimitOptions,
} from "@/lib/oracle/agent/ratelimit";

/**
 * What one question actually costs, and why the budget is counted in calls.
 *
 * The limiter sits on `/api/llm/<provider>`, which forwards ONE model call. The
 * agent, though, answers a question with a tool loop: `MAX_STEPS` in
 * lib/agent/client-run.ts is 12, so a single question can spend up to twelve
 * model calls before it writes a word. The vendored budget was fifteen per ten
 * minutes and its comment called that "fifteen questions"; in this application
 * it was 1.25 questions, and a visitor who hit it was told a reason that was
 * false - they were refused part way through their second answer and read that
 * they had asked fifteen questions.
 *
 * Two ways to make the accounting and the message agree. Counting QUESTIONS was
 * rejected: this route cannot see a question. It sees a model call, and the only
 * way it could learn which call opened a turn is if the browser told it - a
 * client supplied turn marker, on a public endpoint, is a field an abuser sets
 * to "new question" on every request, which would delete the protection this
 * limiter exists to provide. Counting what is spent is also what matches the
 * thing being protected: the cost is tokens and function seconds, and those are
 * per call, not per question.
 *
 * So the unit stays the model call, the budget is stated as a number of calls,
 * and the number is derived from a question count rather than guessed at. The
 * 429 says both, so a refusal mid-answer reads as what it is.
 */
export const AGENT_STEPS_PER_QUESTION = 12;

/**
 * Full-depth questions one address may ask per window.
 *
 * Twelve, because the budget has to survive a reviewer working through the Ask
 * page: they will ask several questions in a row, and every one of them can go
 * the full twelve steps. Deliberately expressed here rather than as a raw call
 * count, so that raising `MAX_STEPS` cannot silently halve how many questions a
 * visitor gets.
 */
export const AGENT_QUESTION_BUDGET = 12;

/** Ten minutes. A browsing session, which is the unit a budget like this fits. */
export const AGENT_RATE_WINDOW_MS = 10 * 60 * 1000;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How many model calls one address may make per window.
 *
 * `AGENT_RATE_LIMIT` keeps the meaning it has always had in the code - a ceiling
 * on forwarded model calls - so an operator who set it is not silently given a
 * different cap. `AGENT_QUESTION_BUDGET` is the friendlier way to say the same
 * thing and is multiplied out here; it is ignored when the call ceiling is set
 * directly.
 */
export function agentModelCallBudget(env: NodeJS.ProcessEnv = process.env): number {
  const questions = readPositiveInt(env.AGENT_QUESTION_BUDGET, AGENT_QUESTION_BUDGET);
  return readPositiveInt(env.AGENT_RATE_LIMIT, questions * AGENT_STEPS_PER_QUESTION);
}

/**
 * The budget for the agent's model calls, shadowing the vendored export.
 *
 * The honest limitation the vendored module states still holds in full: this
 * counter lives in the process, Vercel runs several instances and recycles them,
 * so the real cap is per instance per window rather than global.
 */
export const AGENT_RATE_LIMIT = new RateLimiter({
  limit: agentModelCallBudget(),
  windowMs: readPositiveInt(process.env.AGENT_RATE_WINDOW_MS, AGENT_RATE_WINDOW_MS),
});

/**
 * The reason given with a 429, in the unit that was actually counted.
 *
 * Every number in the sentence is read off the decision or off the constants
 * that produced it, so the message cannot drift away from the accounting the way
 * the previous one did.
 */
export function modelCallLimitMessage(
  decision: RateLimitDecision,
  windowMs: number = readPositiveInt(process.env.AGENT_RATE_WINDOW_MS, AGENT_RATE_WINDOW_MS),
): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const questions = Math.floor(decision.limit / AGENT_STEPS_PER_QUESTION);
  const questionText =
    questions >= 1
      ? `at least ${questions} question${questions === 1 ? "" : "s"} of the deepest kind, and more when a question needs less digging`
      : "less than one full-depth question";

  return (
    `Rate limit reached: ${decision.limit} model calls per ${minutes} minutes from one address, ` +
    `shared by everyone using this deployment's key. A question is not one model call - the agent ` +
    `runs a tool loop of up to ${AGENT_STEPS_PER_QUESTION} model calls before it answers - so the ` +
    `budget is ${questionText}. Try again in ${decision.retryAfterSeconds}s.`
  );
}
