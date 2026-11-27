import assert from 'node:assert/strict';
import test from 'node:test';
import entrypoint, { createScheduledHandler } from '../src/scripts/neon-worker.js';
import { checkWorkerDeadline, withinWorkerDeadline, workerDelay } from '../src/services/worker-deadline.js';

const slot = '2026-11-27T06:07:00.000Z';
const invocation = 'valid-test-invocation';
const trigger = 'approved-fixture-trigger';
function request({ time = slot, id = trigger, header = invocation, path = '/trigger', body } = {}) {
  return new Request('https://example.invalid' + path, {
    method: 'POST', headers: header ? { 'x-neon-trigger-invocation-id': header } : {},
    body: body ?? JSON.stringify({ version: 1, invocation_id: invocation,
      trigger: { type: 'schedule', id }, data: { scheduled_at: time } }),
  });
}

test('a Neon event must match the exact trigger, cadence and freshness before any execution', async () => {
  const observed = [];
  const handle = createScheduledHandler({ enabled: () => true, triggerId: () => trigger, clock: () => Date.parse(slot),
    execute: async date => { observed.push(date.toISOString()); return { processed: 0, monitoring: { success: true } }; } });
  assert.equal((await handle(request({ header: '' }))).status, 401);
  assert.equal((await handle(request({ id: 'wrong' }))).status, 401);
  assert.equal((await handle(request({ header: 'different-invocation' }))).status, 401);
  assert.equal((await handle(request({ body: 'x'.repeat(65537) }))).status, 401);
  for (const time of ['2026-11-27T05:37:00Z', '2026-11-27T06:37:00Z', '2026-11-27T06:06:00Z']) {
    assert.equal((await (await handle(request({ time }))).json()).result, 'stale-or-invalid-slot');
  }
  assert.deepEqual(observed, []);
  assert.equal((await (await handle(request())).json()).result, 'complete');
  assert.deepEqual(observed, [slot]);
});

test('default entry point is inert without explicit production gates', async () => {
  const response = await entrypoint.fetch(request());
  assert.deepEqual(await response.json(), { result: 'disabled' });
});

test('nested deadlines cancel waits and leave their caller scope available for recovery', async () => {
  await withinWorkerDeadline(5000, async () => {
    await assert.rejects(withinWorkerDeadline(20, () => workerDelay(1000)), { name: 'AbortError' });
    checkWorkerDeadline();
  });
  await workerDelay(1);
});
