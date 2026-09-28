import { describe, expect, it } from 'vitest';
import {
  addDays,
  localParts,
  relativeDayLabel,
  resolveDueDate,
  safeTimeZone,
  weekdayOf,
  zonedTimeToUtc,
} from './dates';

// 2026-09-28 is a Monday.
const REF = '2026-09-28';

describe('date helpers', () => {
  it('knows the weekday of the reference date', () => {
    expect(weekdayOf(REF)).toBe(1);
    expect(addDays(REF, 3)).toBe('2026-10-01');
  });

  it('converts local wall time to UTC across zones', () => {
    expect(zonedTimeToUtc('2026-10-01', '17:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-01T11:30:00.000Z',
    );
    expect(zonedTimeToUtc('2026-10-01', '17:00', 'America/New_York').toISOString()).toBe(
      '2026-10-01T21:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-10-01', '17:00', 'UTC').toISOString()).toBe(
      '2026-10-01T17:00:00.000Z',
    );
  });

  it('handles DST boundaries', () => {
    // US DST ends 2026-11-01; 17:00 that day is EST (UTC-5).
    expect(zonedTimeToUtc('2026-11-01', '17:00', 'America/New_York').toISOString()).toBe(
      '2026-11-01T22:00:00.000Z',
    );
  });

  it('reads local parts', () => {
    const p = localParts(new Date('2026-09-28T20:00:00Z'), 'Asia/Tokyo');
    expect(p.date).toBe('2026-09-29');
    expect(p.time).toBe('05:00');
    expect(p.weekday).toBe(2);
  });

  it('falls back to UTC for unknown zones', () => {
    expect(safeTimeZone('Not/AZone')).toBe('UTC');
    expect(safeTimeZone(null)).toBe('UTC');
  });

  it('labels relative days', () => {
    expect(relativeDayLabel('2026-09-28', REF)).toBe('today');
    expect(relativeDayLabel('2026-09-29', REF)).toBe('tomorrow');
    expect(relativeDayLabel('2026-10-01', REF)).toBe('Thursday');
    expect(relativeDayLabel('2026-10-20', REF)).toBe('Oct 20');
  });
});

describe('resolveDueDate', () => {
  const cases: [string, string, string | null][] = [
    ['Can you send the Q3 deck by Thursday?', '2026-10-01', null],
    ['Please send it tomorrow EOD', '2026-09-29', '17:00'],
    ['need this by end of week', '2026-10-02', null],
    ['due by Monday', '2026-10-05', null],
    ['by Oct 3 please', '2026-10-03', null],
    ['on 3rd October', '2026-10-03', null],
    ['by 2026-10-15', '2026-10-15', null],
    ['can you do it today by 5pm', '2026-09-28', '17:00'],
    ['in 2 days', '2026-09-30', null],
    ['next week works', '2026-10-05', null],
    ['by Fri.', '2026-10-02', null],
    ['by end of month', '2026-09-30', null],
  ];
  it.each(cases)('%s', (text, date, time) => {
    const r = resolveDueDate(text, REF);
    expect(r?.date).toBe(date);
    expect(r?.time ?? null).toBe(time);
  });

  it('returns null when there is no date', () => {
    expect(resolveDueDate('Can you take a look?', REF)).toBeNull();
    expect(resolveDueDate('I sat on the Monday-ish report', REF)?.date).not.toBe('2026-10-03');
  });

  it('rolls month-day dates into next year when far in the past', () => {
    expect(resolveDueDate('by Jan 5', REF)?.date).toBe('2027-01-05');
  });
});
