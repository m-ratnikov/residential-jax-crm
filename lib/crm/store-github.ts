/**
 * The default CRM backend: JSON documents committed to a git repository.
 *
 * Reads go through the raw CDN, which is fast and needs no credential. Writes go
 * through the GitHub contents API, which needs a token with `contents: write` on
 * one repository. That token is a credential but not a database: nothing is
 * provisioned, nothing runs between requests, and there is no bill.
 *
 * Three things make this workable rather than merely possible:
 *
 * 1. **One document per aggregate.** Two writers touching different opportunities
 *    touch different files, so the common case has no conflict at all.
 * 2. **Unchanged documents are not written.** The matcher runs every thirty
 *    minutes and most passes change nothing; a `put` that matches what is already
 *    stored returns without a commit.
 * 3. **A conflicting write is retried once against the current blob sha**, which
 *    is the only failure mode the contents API actually produces here.
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
const CACHE_MS = 30_000;

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
   * List a collection.
   *
   * The contents API returns the directory listing with a blob sha per file but
   * not the content, so the documents are fetched alongside. For the sizes this
   * application produces - tens to low hundreds of documents - that is one
   * listing plus a parallel fan out, which is fast enough and far simpler than
   * maintaining an index file that two writers would fight over.
   */
  async #load(collection: Collection): Promise<Map<string, Entry>> {
    const cached = this.#cache.get(collection);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.entries;

    const entries = new Map<string, Entry>();

    const response = await fetch(
      `${API}/repos/${this.options.repository}/contents/${this.#path(collection)}?ref=${encodeURIComponent(this.options.branch)}`,
      { headers: this.#headers(), cache: "no-store" },
    );

    // 404 is the ordinary empty state: the directory does not exist until the
    // first document is written.
    if (response.status === 404) {
      this.#cache.set(collection, { at: Date.now(), entries });
      return entries;
    }
    if (!response.ok) {
      throw new Error(`could not list ${collection}: ${response.status} ${await response.text()}`);
    }

    const listing = (await response.json()) as {
      name: string;
      sha: string;
      download_url: string;
    }[];
    const files = listing.filter((file) => file.name.endsWith(".json"));

    const documents = await Promise.all(
      files.map(async (file) => {
        const content = await fetch(file.download_url, { cache: "no-store" });
        if (!content.ok) return null;
        try {
          return { sha: file.sha, document: (await content.json()) as StoredDocument };
        } catch {
          // A document that will not parse is a corrupt write, not a reason to
          // fail the whole listing.
          logError("store.document_unreadable", new Error(file.name), { collection });
          return null;
        }
      }),
    );

    for (const entry of documents) {
      if (entry?.document?.id) entries.set(entry.document.id, entry);
    }

    this.#cache.set(collection, { at: Date.now(), entries });
    return entries;
  }

  #invalidate(collection: Collection): void {
    this.#cache.delete(collection);
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

    await this.#write(
      collection,
      document.id,
      body,
      existing?.sha,
      `crm: ${collection}/${document.id}`,
    );

    entries.set(document.id, { sha: "", document });
    this.#invalidate(collection);
    return document;
  }

  async #write(
    collection: Collection,
    id: string,
    body: string,
    sha: string | undefined,
    message: string,
    attempt = 0,
  ): Promise<void> {
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
      return;
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

    const response = await fetch(
      `${API}/repos/${this.options.repository}/contents/${this.#path(collection, id)}`,
      {
        method: "DELETE",
        headers: { ...this.#headers(), "content-type": "application/json" },
        body: JSON.stringify({
          message: `crm: remove ${collection}/${id}`,
          sha: existing.sha,
          branch: this.options.branch,
          committer: { name: this.options.authorName, email: this.options.authorEmail },
        }),
      },
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`could not remove ${collection}/${id}: ${response.status}`);
    }

    this.#invalidate(collection);
  }

  async clear(collection: Collection): Promise<void> {
    const entries = await this.#load(collection);
    // Sequential on purpose: the contents API serialises commits to a branch
    // anyway, and firing them in parallel just produces conflicts to retry.
    for (const id of entries.keys()) await this.remove(collection, id);
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
