import { randomBytes } from 'node:crypto';

/**
 * UUID version 7 (RFC 9562): 48-bit Unix milliseconds, a 12-bit counter, then random bits.
 *
 *   |   unix_ts_ms (48)   | ver (4) | counter (12) | var (2) | random (62) |
 *
 * Time-ordered, so new primary keys append at the right edge of the B-tree instead of
 * landing on random pages. The counter ("method 1" in RFC 9562 §6.2) keeps ids strictly
 * increasing within one process even when hundreds are created in the same millisecond;
 * ordering only to the millisecond made inserts within a millisecond random, which split
 * index pages 50/50 instead of using PostgreSQL's append-optimised split (see docs/database.md).
 *
 * Generated in the app because PostgreSQL only gets a native uuidv7() in version 18, and
 * because knowing the id before the INSERT lets the outbox event reference it.
 */
const COUNTER_MAX = 0xfff;
let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    counter = randomBytes(2).readUInt16BE() & 0x7ff; // random start, leaves headroom to count up
  } else if (counter < COUNTER_MAX) {
    counter++; // same (or earlier: clock went backwards) millisecond
  } else {
    lastMs++; // counter exhausted: borrow the next millisecond rather than repeat or reorder
    counter = 0;
  }

  const bytes = randomBytes(16);
  bytes.writeUIntBE(lastMs, 0, 6); // 48-bit big-endian timestamp
  bytes[6] = 0x70 | (counter >> 8); // version 7 + counter high bits
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant (10xx)
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7, useful for debugging ("when was this created?"). */
export function uuidv7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
