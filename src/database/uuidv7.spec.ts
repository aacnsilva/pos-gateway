import { z } from 'zod';
import { uuidv7, uuidv7Timestamp } from './uuidv7';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 UUIDs', () => {
    const id = uuidv7();
    expect(z.uuid({ version: 'v7' }).safeParse(id).success).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('encodes the creation time', () => {
    const now = Date.parse('2030-01-01T12:00:00.123Z');
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it('sorts by creation time across milliseconds', () => {
    const base = Date.parse('2031-01-01T00:00:00Z');
    const ids = [base, base + 1, base + 2].map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('is strictly increasing within the same millisecond', () => {
    const now = Date.parse('2032-01-01T00:00:00Z');
    const ids = Array.from({ length: 1000 }, () => uuidv7(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('borrows the next millisecond when the counter runs out, never reordering', () => {
    const now = Date.parse('2033-01-01T00:00:00Z');
    const ids = Array.from({ length: 10_000 }, () => uuidv7(now));
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7Timestamp(ids.at(-1)!)).toBeGreaterThan(now);
  });

  it('stays ordered if the clock goes backwards', () => {
    const now = Date.parse('2034-01-01T00:00:00Z');
    const later = uuidv7(now);
    const afterClockStep = uuidv7(now - 5_000);
    expect(afterClockStep > later).toBe(true);
  });
});
