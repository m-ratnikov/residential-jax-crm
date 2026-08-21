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
 * 3. **A conflicting write is retried once against the current blob sha**, which
 *    is the only failure the contents API actually produces here.
 * 4. **Reads are content addressed, and a write updates the cache in place.**
 *    Both matter for read-after-write. `download_url` points at a CDN that
 *    serves a stale copy for minutes after a commit, and invalidating the cache
 *    on write forces a re-read at exactly the moment the listing is most likely
 *    to be behind. Together those lost a read-modify-write: a note added and
 *    immediately followed by a task read the pre-note document and dropped the
 *    note silently. Fetching blobs by sha cannot be stale by construction.
 *
 * The read cache is per process and short. A serverless instance handling a
 * burst of requests should not re-list a directory for each one, and thirty
 * seconds is short enough that a write from another instance shows up promptly.
 */

import {
  CrmStoreNotWritableError,
  serialise,
  type Collection,
  type CrmStore,
  type StoredDocument,
} from "./store";
import { logEvent, logError } from "@/lib/notify/log";

const API = "https://api.github.com";
/**
 * How long a read is served from this process before the tree is re-read.
 *
 * Sixty seconds rather than thirty, and the trade is explicit: GitHub allows
 * 5,000 requests an hour and this deployment exhausted them once, answering 500
 * to every CRM read for the rest of the window. A write updates this process's
 * cache in place, so the person who made a change never waits for it; what the
 * window bounds is how long ANOTHER instance can show state one minute old.
 * For an acquisitions board that is not a meaningful staleness. For a rate
 * limit, the difference between thirty and sixty seconds is half the traffic.
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
  #rateLimitedUntil = 0;

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
  async #tree(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.#treeCache && now - this.#treeCache.at < CACHE_MS) return this.#treeCache.paths;

    const response = await fetch(
      `${API}/repos/${this.options.repository}/git/trees/${encodeURIComponent(this.options.branch)}?recursive=1`,
      { headers: this.#headers(), cache: "no-store" },
    );

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
   * List a collection.
   *
   * Documents already held at the same sha are reused, so the common case -
   * nothing changed since the last window - costs one tree request and no blob
   * reads at all.
   */
  async #load(collection: Collection): Promise<Map<string, Entry>> {
    const cached = this.#cache.get(collection);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.entries;

    const prefix = `${this.#path(collection)}/`;
    const tree = await this.#tree();
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

    this.#cache.set(collection, { at: Date.now(), entries });
    return entries;
  }

  #invalidate(collection: Collection): void {
    this.#cache.delete(collection);
    // The tree goes too: a write changed a sha, and a stale tree would hand the
    // old one back and undo the read-after-write guarantee below.
    this.#treeCache = null;
  }

  async list<T extends StoredDocument>(collection: Collection): Promise<T[]> {
    const entries = await this.#load(collection);
    return [...entries.values()].map((entry) => entry.document as T);
  }

  async get<T extends StoredDocument>(collection: Collection, id: string): Promise<T | null> {
    const entries = await this.#load(collection);
    return (entries.get(id)?.document as T | undefined) ?? null;
  }

  async put<T extends StoredDocument>(collection: Collection, document: T): Promise<T> {
    if (!this.options.token) {
      throw new CrmStoreNotWritableError("no GitHub token is configured for the document store");
    }

    const entries = await this.#load(collection);
    const existing = entries.get(document.id);
    const body = serialise(document);

    // Unchanged is not written. Most matcher passes change nothing, and a commit
    // per pass would be history noise and a round trip for no reason.
    if (existing && serialise(existing.document) === body) return document;

    const sha = await this.#write(
      collection,
      document.id,
      body,
      existing?.sha,
      `crm: ${collection}/${document.id}`,
    );

    // Kept in the cache with its new sha rather than invalidated. Invalidating
    // would force a re-read, and a read straight after a write is exactly the
    // moment the remote is most likely to be behind. This way the process that
    // wrote a document always reads back what it wrote, and it costs no request.
    entries.set(document.id, { sha, document });
    this.#cache.set(collection, { at: Date.now(), entries });
    return document;
  }

  async #write(
    collection: Collection,
    id: string,
    body: string,
    sha: string | undefined,
    message: string,
    attempt = 0,
  ): Promise<string> {
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
      return written.content?.sha ?? "";
    }

    // 409 or 422 means the blob moved under us, which happens when the matcher
    // and a person write the same document at the same moment. Re-read the
    // current sha and try once more; a second failure is a real error.
    if ((response.status === 409 || response.status === 422) && attempt === 0) {
      this.#invalidate(collection);
      const current = await this.#load(collection);
      const currentSha = current.get(id)?.sha;
      return this.#write(collection, id, body, currentSha, message, attempt + 1);
    }

    throw new Error(
      `could not write ${collection}/${id}: ${response.status} ${await response.text()}`,
    );
  }

  async remove(collection: Collection, id: string): Promise<void> {
    if (!this.options.token) {
      throw new CrmStoreNotWritableError("no GitHub token is configured for the document store");
    }

    const entries = await this.#load(collection);
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
    const entries = await this.#load(collection);
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
