/**
 * An in-process document store.
 *
 * Two jobs. It is what the tests run against, so a test needs no network and no
 * credential. And it is the fallback when nothing else is configured, which
 * means a fresh `git clone && pnpm dev` gets a working CRM immediately - saved
 * searches, alerts, opportunities, outreach, the whole loop - that simply does
 * not survive a restart.
 *
 * That last part is stated on screen rather than left to be discovered. An
 * ephemeral store is the right default for trying the thing out and the wrong
 * one for running a business on, and the difference should not be a surprise.
 */

import { serialise, type Collection, type CrmStore, type StoredDocument } from "./store";

export class MemoryCrmStore implements CrmStore {
  readonly kind = "memory";
  readonly location = "this process only, lost on restart";
  readonly writable = true;

  #collections = new Map<Collection, Map<string, string>>();

  #bucket(collection: Collection): Map<string, string> {
    let bucket = this.#collections.get(collection);
    if (!bucket) {
      bucket = new Map();
      this.#collections.set(collection, bucket);
    }
    return bucket;
  }

  // Documents are held serialised so a caller cannot mutate stored state by
  // holding on to the object it wrote, which is the classic in-memory store bug.
  async list<T extends StoredDocument>(collection: Collection): Promise<T[]> {
    return [...this.#bucket(collection).values()].map((raw) => JSON.parse(raw) as T);
  }

  async get<T extends StoredDocument>(collection: Collection, id: string): Promise<T | null> {
    const raw = this.#bucket(collection).get(id);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async put<T extends StoredDocument>(collection: Collection, document: T): Promise<T> {
    this.#bucket(collection).set(document.id, serialise(document));
    return document;
  }

  /**
   * There is no concurrency to lose an update to inside one process: nothing
   * else can run between the read and the write, because there is no await
   * between them. So this is the read-modify-write it looks like, and it is
   * here to satisfy the same contract the git backend has to work harder for.
   */
  async update<T extends StoredDocument>(
    collection: Collection,
    id: string,
    mutate: (current: T | null) => T | null,
  ): Promise<T | null> {
    const bucket = this.#bucket(collection);
    const raw = bucket.get(id);
    const next = mutate(raw ? (JSON.parse(raw) as T) : null);
    if (!next) return null;
    bucket.set(next.id, serialise(next));
    return next;
  }

  async remove(collection: Collection, id: string): Promise<void> {
    this.#bucket(collection).delete(id);
  }

  async clear(collection: Collection): Promise<void> {
    this.#bucket(collection).clear();
  }
}

/**
 * One store per process, so a serverless instance keeps its state between warm
 * invocations rather than starting empty on each request.
 */
const globalCache = globalThis as unknown as { __jaxCrmMemoryStore?: MemoryCrmStore };

export function memoryStore(): MemoryCrmStore {
  globalCache.__jaxCrmMemoryStore ??= new MemoryCrmStore();
  return globalCache.__jaxCrmMemoryStore;
}
