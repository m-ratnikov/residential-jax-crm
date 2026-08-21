/**
 * A stable fingerprint that runs in both a browser and Node.
 *
 * This used to be `createHash("sha256")`, which is fine on a server and
 * unavailable in a tab. The same fingerprint has to be computable in both
 * places now that parcel queries run in the browser and the scheduled matcher
 * runs in Node: if the two disagreed, every parcel would look changed on the
 * first pass after a search was run from the other side.
 *
 * FNV-1a over 128 bits, in BigInt. It is not a cryptographic hash and does not
 * need to be - nothing here defends against an adversary choosing an input. It
 * needs to be deterministic, identical on both runtimes, and unlikely to
 * collide across a few hundred thousand parcels. At 128 bits the chance of any
 * collision across the whole county roll is far below the chance of the county
 * publishing the row wrong.
 *
 * The consequence of a collision, for the record, is one missed "this parcel
 * changed" alert. Not a wrong alert, and not a lost parcel.
 */

const FNV_OFFSET_128 = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME_128 = 0x0000000001000000000000000000013bn;
const MASK_128 = (1n << 128n) - 1n;

/**
 * @returns 32 lowercase hex characters, the same width the previous sha256
 * prefix produced, so stored fingerprints stay the same length.
 */
export function fingerprint(input: string): string {
  let hash = FNV_OFFSET_128;

  // Hashing UTF-8 bytes rather than UTF-16 code units, so an owner name with a
  // non-ASCII character fingerprints identically wherever it is computed.
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_128) & MASK_128;
  }

  return hash.toString(16).padStart(32, "0");
}
