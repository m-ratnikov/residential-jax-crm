/**
 * A Postgres document backend, kept as an option rather than the default.
 *
 * A team that already runs a database and wants real concurrency should be able
 * to point at it, and this is sixty lines rather than a schema. The whole store
 * is one table:
 *
 *   crm_documents(collection text, id text, document jsonb, updated_at timestamptz)
 *
 * The invariants that used to need unique indexes are already enforced by the
 * document keys, so this table needs exactly one: the primary key.
 *
 * It is not the default because the story asks for the CRM to run "without
 * requiring Oracle to carry ongoing hosted-database cost", and a hosted database
 * is a hosted database whether or not its free tier happens to cost nothing
 * today.
 */

import { neon } from "@neondatabase/serverless";

import {
  MAX_UPDATE_ATTEMPTS,
  serialise,
  type Collection,
  type CrmStore,
  type StoredDocument,
} from "./store";

type Sql = ReturnType<typeof neon>;

export class PostgresCrmStore implements CrmStore {
  readonly kind = "postgres-documents";
  readonly writable = true;

  #ready: Promise<void> | null = null;

  constructor(
    private readonly sql: Sql,
    readonly location: string,
  ) {}

  /** Created on first use, so there is no migration step to forget. */
  async #ensure(): Promise<void> {
    this.#ready ??= (async () => {
      await this.sql`
        CREATE TABLE IF NOT EXISTS crm_documents (
          collection text NOT NULL,
          id text NOT NULL,
          document jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (collection, id)
        )
      `;
    })().catch((error: unknown) => {
      this.#ready = null; // a failed create must not poison the handle
      throw error;
    });
    return this.#ready;
  }

  async list<T extends StoredDocument>(collection: Collection): Promise<T[]> {
    await this.#ensure();
    const rows = (await this.sql`
      SELECT document FROM crm_documents WHERE collection = ${collection}
    `) as { document: T }[];
    return rows.map((row) => row.document);
  }

  async get<T extends StoredDocument>(collection: Collection, id: string): Promise<T | null> {
    await this.#ensure();
    const rows = (await this.sql`
      SELECT document FROM crm_documents WHERE collection = ${collection} AND id = ${id}
    `) as { document: T }[];
    return rows[0]?.document ?? null;
  }

  async put<T extends StoredDocument>(collection: Collection, document: T): Promise<T> {
    await this.#ensure();
    await this.sql`
      INSERT INTO crm_documents (collection, id, document, updated_at)
      VALUES (${collection}, ${document.id}, ${serialise(document)}::jsonb, now())
      ON CONFLICT (collection, id)
      DO UPDATE SET document = EXCLUDED.document, updated_at = now()
    `;
    return document;
  }

  /**
   * Read, change, write, as a compare and set on the document itself.
   *
   * The driver is Neon's HTTP one, which has no session and therefore no
   * transaction to hold a row lock in. So the guard is the value that was read:
   * the UPDATE only matches while the stored document is still the one `mutate`
   * was handed, and a row count of zero means somebody else wrote in between and
   * the mutation has to be re-run against what they left. `jsonb` equality is
   * semantic rather than textual, so key order cannot make this spin.
   */
  async update<T extends StoredDocument>(
    collection: Collection,
    id: string,
    mutate: (current: T | null) => T | null,
  ): Promise<T | null> {
    await this.#ensure();

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.get<T>(collection, id);
      const next = mutate(current);
      if (!next) return null;
      const body = serialise(next);

      const rows = current
        ? ((await this.sql`
            UPDATE crm_documents
               SET document = ${body}::jsonb, updated_at = now()
             WHERE collection = ${collection}
               AND id = ${id}
               AND document = ${serialise(current)}::jsonb
            RETURNING id
          `) as { id: string }[])
        : ((await this.sql`
            INSERT INTO crm_documents (collection, id, document, updated_at)
            VALUES (${collection}, ${id}, ${body}::jsonb, now())
            ON CONFLICT (collection, id) DO NOTHING
            RETURNING id
          `) as { id: string }[]);

      if (rows.length > 0) return next;
    }

    throw new Error(
      `could not update ${collection}/${id}: the document was changed by another writer on every one of ${MAX_UPDATE_ATTEMPTS} attempts`,
    );
  }

  async remove(collection: Collection, id: string): Promise<void> {
    await this.#ensure();
    await this.sql`DELETE FROM crm_documents WHERE collection = ${collection} AND id = ${id}`;
  }

  async clear(collection: Collection): Promise<void> {
    await this.#ensure();
    await this.sql`DELETE FROM crm_documents WHERE collection = ${collection}`;
  }
}

export function postgresStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PostgresCrmStore | null {
  const url = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim();
  if (!url) return null;

  // The host only, never the credentials, so this can be shown in the UI.
  let host = "postgres";
  try {
    host = new URL(url).host;
  } catch {
    // A malformed URL fails later with a clearer message than anything said here.
  }

  return new PostgresCrmStore(neon(url), host);
}
