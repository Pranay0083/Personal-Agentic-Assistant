import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { errorInfo, sanitizeJobError, SanitizedJobError } from './errors';

const dbError = () =>
  Object.assign(
    new Error(
      'Failed query: insert into "tasks" ("title") values ($1)\nparams: Send the BLUEBIRD numbers',
    ),
    { name: 'DrizzleQueryError', cause: { code: '23505', detail: 'Key (title)=(BLUEBIRD)' } },
  );

describe('job error sanitizing', () => {
  it('errorInfo keeps only the class name, driver code and status', () => {
    expect(errorInfo(dbError())).toEqual({ err: 'DrizzleQueryError', code: '23505' });
    expect(errorInfo(Object.assign(new Error('x'), { status: 503 }))).toEqual({
      err: 'Error',
      status: 503,
    });
    expect(JSON.stringify(errorInfo(dbError()))).not.toContain('BLUEBIRD');
  });

  it('replaces errors bound for BullMQ with a param-free one', () => {
    const safe = sanitizeJobError(dbError());
    expect(safe).toBeInstanceOf(SanitizedJobError);
    expect(safe.message).toBe('DrizzleQueryError code=23505');
    expect(String(safe.stack)).not.toContain('BLUEBIRD');
    expect(JSON.stringify(safe)).not.toContain('BLUEBIRD');
    // Worker `failed` handlers still log the original class.
    expect(errorInfo(safe)).toEqual({ err: 'DrizzleQueryError', code: '23505' });
  });

  it('passes BullMQ control-flow errors through unchanged', () => {
    const u = new UnrecoverableError('invalid agent job');
    expect(sanitizeJobError(u)).toBe(u);
  });
});
