import { afterAll, describe, expect, it } from 'vitest';
import { closeQueues } from './queue';
import { publishLive, subscribeLive } from './live';

const USER = '00000000-0000-0000-0000-00000000live';

afterAll(() => closeQueues());

describe('live events', () => {
  it('survives streams that close immediately (no unhandled rejection)', async () => {
    for (let i = 0; i < 20; i++) subscribeLive(USER, () => {})();
    await new Promise((r) => setTimeout(r, 300));
  });

  it('delivers published events and stops after close', async () => {
    const got: unknown[] = [];
    const close = subscribeLive(USER, (e) => got.push(e));
    await new Promise((r) => setTimeout(r, 200));
    await publishLive(USER, { type: 'control.changed', paused: true });
    await new Promise((r) => setTimeout(r, 200));
    close();
    await publishLive(USER, { type: 'control.changed', paused: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([{ type: 'control.changed', paused: true }]);
  });
});
