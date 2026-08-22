/**
 * The default CRM backend: JSON documents committed to a git repository.
 *
 * Writes go through the GitHub contents API, which needs a token with
 * `contents: write` on one repository. That token is a credential but not a
 * database: nothing is provisioned, nothing runs between requests, and there is
 * no bill.
 *
 * Four things make this workable rather than merely possible:
 *
 * 1. **One document per aggregate.** Two writers touching different
 *    opportunities touch different files, so the common case has no conflict.
 * 2. **Unchanged documents are not written.** The matcher runs every thirty
 *    minutes and most passes change nothing; a `put` matching what is stored
 *    returns without a commit, so steady state produces no history at all.
 * 3. **A conflicting write re-runs the mutation against the current document.**
 *    A conflict is the only failure the contents API actually produces here,
 *    and git cannot merge two JSON documents for us, so `update` re-reads and
 *    re-applies rather than re-sending a body that is already stale. See the
 *    note on `update` for the lost note this cost before it did.
 * 4. **Reads are content addressed, and a write updates the cache in place.**
 *    Both matter for read-after-write. `download_url` points at a CDN that
 *    serves a stale copy for minutes after a commit, and invalidating the cache
 *    on write forces a re-read at exactly the moment the listing is most likely
 *    to be behind. Together those lost a read-modify-write: a note added and
 *    immediately followed by a task read the pre-note document and dropped the
 *    note silently. Fetching blobs by sha cannot be stale by construction.
 *
 * The read cache is per process, and a per-process cache cannot be trusted to
 * expire on a clock. Several instances serve one deployment, so a PATCH lands
 * on one and the reload after it is routed to another: a time-based window
 * means that second instance can show state from before a change that has
 * already been acknowledged. Reads therefore REVALIDATE - one conditional
 * request against the branch, which GitHub answers 304 for free when nothing
 * has moved - and the cache is what makes that answer cost nothing to act on.
 * The clock survives only on the write path, where a stale read costs a
 * conflict and a retry rather than a wrong answer.
 */

import {
  CrmStoreNotWritableError,
  MAX_UPDATE_ATTEMPTS,
  serialise,
  type Collection,
  type CrmStore,
  type StoredDocument,
} from "./store";
import { logEvent, logError } from "@/lib/notify/log";

const API = "https://api.github.com";
/**
 * How old a tree the WRITE path will compute against.
 *
 * This used to gate reads as well, and that was the bug. A serverless
 * deployment runs many instances and each held its own cache: a PATCH landed on
 * one, the reload after it was routed to another, and that one served a tree up
 * to a minute old. The stage change had been committed and acknowledged and the
 * board still showed the old stage. No amount of `cache: "no-store"` in the
 * browser fixes that, because the origin itself is behind.
 *
 * So reads no longer consult this window at all - see `#tree` - and the window
 * now covers only the write path, where staleness is not a correctness problem:
 * a `put` is last-writer-wins by contract, and an `update` computing against a
 * stale sha is refused by GitHub, re-reads, and re-runs the mutation. Keeping
 * writes on the cached tree is what stops a bulk loop - a campaign across
 * hundreds of opportunities - from spending one tree read per document on top
 * of the write itself. That amplification is what once exhausted GitHub's
 * 5,000 requests an hour and took every CRM read down with it.
 */
const CACHE_MS = 60_000;

export interface GitHubStoreOptions {
  /** `owner/repo`. */
  repository: string;
  branch: string;
  /** Directory inside the repository holding the collections. */
  root: string;
  /** Absent means read-only: the app can show state but not change it. */
  token: string | null;
  /** Commit author, so the history says what wrote each change. */
  authorName: string;
  authorEmail: string;
}

interface Entry {
  sha: string;
  document: StoredDocument;
}

interface CacheEntry {
  at: number;
  entries: Map<string, Entry>;
  /**
   * The tree these entries were built from, held by reference.
   *
   * A revalidation that answers 304 hands back the very same map, so an
   * identity check is enough to know every sha is unchanged and the documents
   * with them. That is what makes revalidating on every read cheap in work as
   * well as in budget: the common case is one conditional request and nothing
   * else at all.
   */
  tree: Map<string, string>;
}

export class GitHubCrmStore implements CrmStore {
  readonly kind = "github-documents";

  #cache = new Map<Collection, CacheEntry>();
  /** path -> blob sha for the whole branch, so a read costs one request. */
  #treeCache: { at: number; paths: Map<string, string> } | null = null;
  /**
   * The last tree that was successfully read, with no expiry.
   *
   * GitHub's 5,000 requests an hour are counted per USER, not per token, so
   * every token this account owns shares one budget - a local script and the
   * deployment drain the same pool. When it runs out, every read fails for the
   * remainder of the hour, and a CRM that answers 500 to its own board is worse
   * than one showing state a few minutes old. So an exhausted budget degrades
   * to the last known-good copy and says so, instead of failing.
   */
  #lastGoodTree: Map<string, string> | null = null;
  /**
   * The ETag of the last tree read, so the next read can be conditional.
   *
   * A request that answers 304 Not Modified does not count against the hourly
   * budget. Measured against the live API: two unconditional reads took the
   * remaining count 4996 -> 4995, then three consecutive conditional reads all
   * reported 4994. So polling for changes is free, and the budget is only spent
   * when something has actually changed - which is the difference between a
   * store that costs one request per minute per instance and one that costs one
   * request per write.
   */
  #treeEtag: string | null = null;
  #rateLimitedUntil = 0;
  /**
   * The revalidation currently in flight, so concurrent callers share one.
   *
   * This is what makes "revalidate on every read" affordable in latency. One
   * page load lists opportunities, owners, team and searches inside a single
   * `Promise.all`; without this each would open its own conditional request to
   * GitHub for the identical answer.
   */
  #treeInflight: Promise<Map<string, string>> | null = null;

  /** True when the last read was served from a stale copy after a refusal. */
  get degraded(): boolean {
    return Date.now() < this.#rateLimitedUntil;
  }

  constructor(private readonly options: GitHubStoreOptions) {}

  get location(): string {
    return `${this.options.repository}@${this.options.branch}/${this.options.root}`;
  }

  get writable(): boolean {
    return Boolean(this.options.token);
  }

  #path(collection: Collection, id?: string): string {
    const base = `${this.options.root}/${collection}`;
    return id ? `${base}/${id}.json` : base;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    return headers;
  }

  /**
   * The whole branch in one request, as path -> blob sha.
   *
   * This replaced a per-collection directory listing, and the reason is a
   * production outage rather than tidiness. The old shape cost one listing plus
   * one blob per document on every cache miss, per collection, per serverless
   * instance. A single page load touches four collections; a browsing session
   * touches them repeatedly; several instances each keep their own cache. That
   * arithmetic reached GitHub's 5,000 requests an hour and the deployment began
   * answering 500 to every CRM read - with the data intact and nothing wrong
   * except the number of times it had been asked for.
   *
   * The trees API returns every path and sha under the branch in one call. A
   * blob is then fetched only when its sha is one this process has not already
   * read, so a warm instance costs ONE request per window no matter how many
   * documents it serves, and a cold one costs 1 + the documents it actually
   * needs. Content addressing is what makes that safe: a sha that has not
   * changed cannot be stale.
   */
  async #tree(revalidate: boolean): Promise<Map<string, string>> {
    // Whoever is already asking is asking the same question. Join them.
    const inflight = this.#treeInflight;
    if (inflight) return inflight;

    const now = Date.now();

    // While the budget is exhausted every request is refused until the reset,
    // so there is nothing to gain by making one. Serve the last good copy; the
    // `degraded` flag is what tells the UI it is showing state a few minutes
    // old rather than implying it is current.
    if (now < this.#rateLimitedUntil && this.#lastGoodTree) return this.#lastGoodTree;

    // The read path never takes this branch. See the note on CACHE_MS.
    if (!revalidate && this.#treeCache && now - this.#treeCache.at < CACHE_MS) {
      return this.#treeCache.paths;
    }

    const started = this.#fetchTree(now);
    this.#treeInflight = started;
    try {
      return await started;
    } finally {
      // Only if it is still ours: an `#invalidate` in between may already have
      // dropped it and a newer revalidation may have taken its place.
      if (this.#treeInflight === started) this.#treeInflight = null;
    }
  }

  /**
   * One conditional request for the whole branch.
   *
   * Conditional is the whole economics of this. Measured against the live API:
   * two unconditional reads took the remaining count 4996 -> 4995, then three
   * consecutive conditional reads all reported 4994. A 304 is free, so a read
   * that revalidates on every call costs budget only when something has
   * actually changed - which means the cost is bounded by the number of WRITES,
   * not by the number of reads.
   */
  async #fetchTree(now: number): Promise<Map<string, string>> {
    const response = await fetch(
      `${API}/repos/${this.options.repository}/git/trees/${encodeURIComponent(this.options.branch)}?recursive=1`,
      {
        headers: {
          ...this.#headers(),
          // Free when nothing has changed. See the note on #treeEtag.
          ...(this.#treeEtag && this.#lastGoodTree ? { "if-none-match": this.#treeEtag } : {}),
        },
        cache: "no-store",
      },
    );

    // Nothing has changed since the last read, and this cost no budget.
    if (response.status === 304 && this.#lastGoodTree) {
      this.#treeCache = { at: now, paths: this.#lastGoodTree };
      this.#rateLimitedUntil = 0;
      return this.#lastGoodTree;
    }

    // 404 is the ordinary empty state: the branch does not exist until the
    // first write creates it.
    if (response.status === 404) {
      const empty = new Map<string, string>();
      this.#treeCache = { at: now, paths: empty };
      return empty;
    }
    if (response.status === 403 || response.status === 429) {
      // Rate limited. Serve what was last read rather than taking the CRM down;
      // the reset header says how long, and until then every read is refused so
      // there is nothing to gain by asking again.
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      this.#rateLimitedUntil = reset > now ? reset : now + 60_000;
      logError("store.rate_limited", new Error(`${response.status}`), {
        until: new Date(this.#rateLimitedUntil).toISOString(),
        serving: this.#lastGoodTree ? "the last good tree" : "nothing",
      });
      if (this.#lastGoodTree) {
        this.#treeCache = { at: now, paths: this.#lastGoodTree };
        return this.#lastGoodTree;
      }
      throw new Error(
        `the CRM store is rate limited by GitHub until ${new Date(this.#rateLimitedUntil).toISOString()} and has nothing cached to serve`,
      );
    }
    if (!response.ok) {
      throw new Error(`could not read the tree: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as {
      tree?: { path: string; type: string; sha: string }[];
      truncated?: boolean;
    };

    // GitHub truncates a tree over 100,000 entries. This store holds hundreds,
    // so it is a guard against a surprise rather than an expected path - but a
    // silently short listing would read as "those documents were deleted".
    if (body.truncated) {
      throw new Error(
        "the CRM branch has more files than one tree request returns; the store needs paging before it can be trusted",
      );
    }

    const paths = new Map<string, string>();
    for (const node of body.tree ?? []) {
      if (node.type === "blob" && node.path.endsWith(".json")) paths.set(node.path, node.sha);
    }

    this.#treeCache = { at: now, paths };
    this.#lastGoodTree = paths;
    this.#treeEtag = response.headers.get("etag");
    this.#rateLimitedUntil = 0;
    return paths;
  }

  /** One blob by sha, content addressed and therefore never stale. */
  async #blob(sha: string): Promise<StoredDocument | null> {
    const response = await fetch(`${API}/repos/${this.options.repository}/git/blobs/${sha}`, {
      headers: { ...this.#headers(), accept: "application/vnd.github.raw" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    try {
      return (await response.json()) as StoredDocument;
    } catch {
      // A document that will not parse is a corrupt write, not a reason to fail
      // the whole listing.
      logError("store.document_unreadable", new Error(sha), {});
      return null;
    }
  }

  /**
   * Load a collection.
   *
   * `revalidate` is the read-your-write guarantee. With it, the tree is checked
   * against GitHub before anything is served, so this instance cannot answer
   * with state older than a write another instance has already acknowledged.
   * Without it, the cached tree is used - which is what the write path wants,
   * because a stale sha there costs a conflict and a retry rather than a wrong
   * answer, and because re-reading the tree once per document would put back
   * the request amplification that once took the deployment down.
   *
   * Documents already held at the same sha are reused, so the ordinary case -
   * revalidate, get a 304 - costs one conditional request, no budget, and no
   * blob reads at all.
   */
  async #load(collection: Collection, revalidate: boolean): Promise<Map<string, Entry>> {
    const cached = this.#cache.get(collection);
    if (!revalidate && cached && Date.now() - cached.at < CACHE_MS) return cached.entries;

    const prefix = `${this.#path(collection)}/`;
    const tree = await this.#tree(revalidate);

    // The identical tree came back, so every sha under this prefix is the one
    // these entries were built from and there is nothing to rebuild.
    if (cached && cached.tree === tree) return cached.entries;

    const known = cached?.entries ?? this.#cache.get(collection)?.entries;

    const wanted: { id: string; sha: string }[] = [];
    for (const [path, sha] of tree) {
      if (!path.startsWith(prefix)) continue;
      wanted.push({ id: path.slice(prefix.length).replace(/\.json$/, ""), sha });
    }

    const entries = new Map<string, Entry>();
    const fetched = await Promise.all(
      wanted.map(async ({ id, sha }) => {
        const held = known?.get(id);
        if (held && held.sha === sha) return { id, entry: held };
        const document = await this.#blob(sha);
        if (document) return { id, entry: { sha, document } };
        // The blob could not be read - most often the same rate limit. An older
        // copy of the document beats the document vanishing from the listing,
        // which would read as "somebody deleted this deal".
        return held ? { id, entry: held } : null;
      }),
    );

    for (const item of fetched) {
      if (item?.entry.document?.id) entries.set(item.entry.document.id, item.entry);
    }

    this.#cache.set(collection, { at: Date.now(), entries, tree });
    return entries;
  }

  /**
   * Record a document this process has just written, at its new sha.
   *
   * Kept in the cache rather than invalidated. Invalidating would force a
   * re-read, and a read straight after a write is exactly the moment the remote
   * is most likely to be behind. The tree reference is carried over unchanged:
   * it is now one commit out of date, which is what makes the next read-path
   * revalidation see a changed tree and rebuild - reusing this entry by sha, so
   * the rebuild costs no blob read.
   */
  #remember(collection: Collection, entries: Map<string, Entry>, entry: Entry): void {
    entries.set(entry.document.id, entry);
    this.#cache.set(collection, {
      at: Date.now(),
      entries,
      tree: this.#cache.get(collection)?.tree ?? new Map<string, string>(),
    });
  }

  #invalidate(collection: Collection): void {
    this.#cache.delete(collection);
    // The tree goes too: a write changed a sha, and a stale tree would hand the
    // old one back and undo the read-after-write guarantee below.
    this.#treeCache = null;
    // And any revalidation already in flight was started before that write, so
    // joining it would answer from before the change.
    this.#treeInflight = null;
  }

  async list<T extends StoredDocument>(collection: Collection): Promise<T[]> {
    const entries = await this.#load(collection, true);
    return [...entries.values()].map((entry) => entry.document as T);
  }

  async get<T extends StoredDocument>(collection: Collection, id: string): Promise<T | null> {
    const entries = await this.#load(collection, true);
    return (entries.get(id)?.document as T | undefined) ?? null;
  }

  async put<T extends StoredDocument>(collection: Collection, document: T): Promise<T> {
    if (!this.options.token) {
      throw new CrmStoreNotWritableError("no GitHub token is configured for the document store");
    }

    // Not revalidated: a `put` is last-writer-wins by contract, so a stale sha
    // costs one conflict and one retry rather than a wrong answer, and a bulk
    // campaign does not pay a tree read per document.
    const entries = await this.#load(collection, false);
    const existing = entries.get(document.id);
    const body = serialise(document);

    // Unchanged is not written. Most matcher passes change nothing, and a commit
    // per pass would be history noise and a round trip for no reason.
    if (existing && serialise(existing.document) === body) return document;

    const written = await this.#write(
      collection,
      document.id,
      body,
      existing?.sha,
      `crm: ${collection}/${document.id}`,
    );

    if (!written.ok) {
      if (!written.conflict) throw written.error;
      // A blind write that raced. There is no mutation to re-run - the caller
      // said "this is the state now" - so the only honest retry is to re-read
      // the sha and let the last writer win, which is what `put` promises.
      // Anything that must not lose a concurrent change goes through `update`.
      this.#invalidate(collection);
      const current = await this.#load(collection, false);
      const retried = await this.#write(
        collection,
        document.id,
        body,
        current.get(document.id)?.sha,
        `crm: ${collection}/${document.id}`,
      );
      if (!retried.ok) throw retried.error;
      this.#remember(collection, current, { sha: retried.sha, document });
      return document;
    }

    this.#remember(collection, entries, { sha: written.sha, document });
    return document;
  }

  /**
   * Read, change, write, re-running the change against the current document
   * whenever the write races.
   *
   * The bug this replaces was subtle and silent. The old conflict path re-sent
   * the SAME body against the newly fetched sha, which is not a retry: the body
   * was computed from a document that is by definition no longer current, so
   * the write went through and erased whatever the other writer had just added.
   * Two analysts adding a note to the same opportunity within the cache window
   * ended up with one note, and nothing anywhere said the other had been lost.
   *
   * `mutate` is therefore re-run from scratch on each attempt, against a tree
   * that has been invalidated so the read cannot be served from the copy that
   * just lost. Attempts are bounded: a document under real contention settles
   * on the second pass, and a backend that refuses forever should raise rather
   * than hang.
   */
  async update<T extends StoredDocument>(
    collection: Collection,
    id: string,
    mutate: (current: T | null) => T | null,
  ): Promise<T | null> {
    if (!this.options.token) {
      throw new CrmStoreNotWritableError("no GitHub token is configured for the document store");
    }

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      // The first attempt works from the cached tree; a stale one is refused by
      // GitHub and the loop re-reads and re-runs the mutation, which is a
      // cheaper way to be correct than a tree read before every write.
      const entries = await this.#load(collection, attempt > 0);
      const existing = entries.get(id);

      const next = mutate((existing?.document as T | undefined) ?? null);
      if (!next) return null;

      const body = serialise(next);
      // Unchanged is not written, exactly as in `put`.
      if (existing && serialise(existing.document) === body) return next;

      const written = await this.#write(
        collection,
        next.id,
        body,
        existing?.sha,
        `crm: ${collection}/${next.id}`,
      );

      if (written.ok) {
        this.#remember(collection, entries, { sha: written.sha, document: next });
        return next;
      }
      if (!written.conflict) throw written.error;

      // Somebody wrote first. Drop the cached tree so the next read is the
      // state they left, and run the mutation again on top of it.
      this.#invalidate(collection);
      logEvent("store.write_conflict", { collection, id, attempt: attempt + 1 });
    }

    throw new Error(
      `could not update ${collection}/${id}: the document was changed by another writer on every one of ${MAX_UPDATE_ATTEMPTS} attempts`,
    );
  }

  /**
   * One PUT against the contents API.
   *
   * Returns the outcome rather than throwing on a conflict, because a conflict
   * is the one failure the callers handle differently from each other: `put`
   * retries once and lets the last writer win, `update` re-runs the mutation.
   */
  async #write(
    collection: Collection,
    id: string,
    body: string,
    sha: string | undefined,
    message: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; conflict: boolean; error: Error }> {
    const response = await fetch(
      `${API}/repos/${this.options.repository}/contents/${this.#path(collection, id)}`,
      {
        method: "PUT",
        headers: { ...this.#headers(), "content-type": "application/json" },
        body: JSON.stringify({
          message,
          content: Buffer.from(body, "utf8").toString("base64"),
          branch: this.options.branch,
          sha,
          committer: { name: this.options.authorName, email: this.options.authorEmail },
        }),
      },
    );

    if (response.ok) {
      logEvent("store.written", { collection, id });
      const written = (await response.json()) as { content?: { sha?: string } };
      return { ok: true, sha: written.content?.sha ?? "" };
    }

    // 409 or 422 means the blob moved under us, which happens when the matcher
    // and a person write the same document at the same moment.
    const conflict = response.status === 409 || response.status === 422;
    return {
      ok: false,
      conflict,
      error: new Error(
        `could not write ${collection}/${id}: ${response.status} ${await response.text()}`,
      ),
    };
  }

  async remove(collection: Collection, id: string): Promise<void> {
    if (!this.options.token) {
      throw new CrmStoreNotWritableError("no GitHub token is configured for the document store");
    }

    // Revalidated: a document this instance has not seen yet is one this would
    // otherwise silently decline to delete. One request, not one per document.
    const entries = await this.#load(collection, true);
    const existing = entries.get(id);
    if (!existing) return;

    await this.#delete(collection, id, existing.sha);
    this.#invalidate(collection);
  }

  /** Delete one blob. Caller decides when to invalidate, so a bulk delete can. */
  async #delete(collection: Collection, id: string, sha: string): Promise<void> {
    const response = await fetch(
      `${API}/repos/${this.options.repository}/contents/${this.#path(collection, id)}`,
      {
        method: "DELETE",
        headers: { ...this.#headers(), "content-type": "application/json" },
        body: JSON.stringify({
          message: `crm: remove ${collection}/${id}`,
          sha,
          branch: this.options.branch,
          committer: { name: this.options.authorName, email: this.options.authorEmail },
        }),
      },
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`could not remove ${collection}/${id}: ${response.status}`);
    }
  }

  async clear(collection: Collection): Promise<void> {
    if (!this.options.token) {
      throw new CrmStoreNotWritableError("no GitHub token is configured for the document store");
    }

    // The tree is read once, before the loop, and invalidated once after it.
    // Going through `remove` invalidated it on every deletion, so clearing a
    // hundred alerts spent a hundred tree reads on top of a hundred deletes and
    // walked the account into GitHub's hourly limit - the same amplification
    // that took the deployment down, reintroduced by the cache that fixed it.
    //
    // Still sequential: the contents API serialises commits to a branch anyway,
    // so firing them in parallel only produces conflicts to retry.
    const entries = await this.#load(collection, true);
    for (const [id, entry] of entries) await this.#delete(collection, id, entry.sha);
    this.#invalidate(collection);
  }
}

export function githubStoreFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubCrmStore | null {
  const repository = env.CRM_STORE_REPO?.trim();
  if (!repository) return null;

  return new GitHubCrmStore({
    repository,
    branch: env.CRM_STORE_BRANCH?.trim() || "crm-state",
    root: env.CRM_STORE_ROOT?.trim() || "crm",
    token: env.CRM_STORE_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || null,
    authorName: env.CRM_STORE_AUTHOR_NAME?.trim() || "duval-acquisitions-crm",
    authorEmail: env.CRM_STORE_AUTHOR_EMAIL?.trim() || "crm@example.invalid",
  });
}
