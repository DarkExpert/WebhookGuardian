import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { compileServer, TestProcess } from './helpers/processes.js';
import type { PaymentEvent } from '../src/handler.js';

const secret = 'reliability-test-only-signing-secret-32-bytes';
let compiled: string | undefined;
let directory: string | undefined;
let database: string;
let children: TestProcess[] = [];
let servers: Map<string, TestProcess>;
beforeAll(() => { compiled = compileServer(); }, 35000);
afterAll(() => { if (compiled) rmSync(compiled, { recursive: true, force: true }); });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'guardian-reliability-'));
  database = join(directory, 'guardian.sqlite');
  children = [];
  servers = new Map();
});
afterEach(async context => {
  const results = await Promise.allSettled(children.map(child => child.stop(true)));
  const errors = results.filter(result => result.status === 'rejected').length;
  let fileCleanupFailed = false;
  if (children.every(child => child.closed) && directory) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { fileCleanupFailed = true; }
  }
  if (errors || fileCleanupFailed || children.some(child => !child.closed)) {
    const message = 'Reliability teardown failed; test-owned resources require inspection';
    if (context.task.result?.state === 'fail') console.error(message);
    else throw new Error(message);
  }
});

function event(eventId: string, paymentId = eventId): PaymentEvent {
  return { schemaVersion: '1', eventId, eventType: 'payment.completed',
    occurredAt: '2026-10-12T12:00:00Z', paymentId };
}
function start(mode: string, point = ''): TestProcess {
  if (!compiled) throw new Error('Reliability build did not initialize');
  const worker = new TestProcess(compiled, database, mode, secret, point);
  children.push(worker);
  return worker;
}
async function server(): Promise<string> {
  const worker = start('server');
  const ready = await worker.waitFor('ready');
  if (!ready.url) throw new Error('Server did not report its bound endpoint');
  servers.set(ready.url, worker);
  return ready.url;
}
function state() {
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    return {
      events: reader.prepare('SELECT event_id, state, activation_created FROM inbox ORDER BY event_id').all(),
      activations: reader.prepare('SELECT payment_id, event_id FROM payment_activations ORDER BY payment_id').all(),
    };
  } finally { reader.close(); }
}
interface Reply { outcome: string; activationCreated?: boolean }
async function deliver(url: string, payment: PaymentEvent) {
  const body = JSON.stringify(payment);
  const signature = `v1=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const requestId = randomUUID();
  const response = await fetch(`${url}/webhooks/mock-payment`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature, 'x-test-request-id': requestId },
    signal: AbortSignal.timeout(10000),
  });
  const result = { status: response.status, body: await response.json() as Reply };
  if (result.status === 503) {
    expect(result.body).toEqual({ outcome: 'ProcessingFailed' });
    const worker = servers.get(url);
    if (!worker) throw new Error('No test-owned server diagnostic channel');
    const diagnostic = await worker.waitFor('processing-error', 10000, requestId);
    if (diagnostic.kind !== 'contention' || ![5, 6].includes(diagnostic.sqliteCode ?? -1)) {
      throw new Error('Unexpected internal failure; generic 503 is not proven SQLite contention');
    }
  }
  return result;
}
async function sender(url: string, payment: PaymentEvent): Promise<Reply> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await deliver(url, payment);
    if (response.status === 503) {
      expect(response.body).toEqual({ outcome: 'ProcessingFailed' });
      await setImmediate(); // Sender retries only after an actual transient response.
      continue;
    }
    expect(response.status).toBe(200);
    expect(['Processed', 'Duplicate']).toContain(response.body.outcome);
    return response.body;
  }
  throw new Error('Sender exhausted 3 attempts; all 503 responses were confirmed SQLite contention');
}

it('deduplicates identical concurrent deliveries across separate server processes', async () => {
  const first = await server();
  const second = await server();
  expect(children[0]?.child.pid).not.toBe(children[1]?.child.pid);
  const payment = event('same_event');
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => sender(i % 2 ? first : second, payment)));
  expect(replies.filter(reply => reply.outcome === 'Processed')).toHaveLength(1);
  expect(replies.filter(reply => reply.outcome === 'Duplicate')).toHaveLength(19);
  expect(state()).toEqual({
    events: [{ event_id: payment.eventId, state: 'completed', activation_created: 1 }],
    activations: [{ payment_id: payment.paymentId, event_id: payment.eventId }],
  });
}, 35000);

it('activates one payment once when separate processes receive different event IDs', async () => {
  const first = await server();
  const second = await server();
  const payments = Array.from({ length: 20 }, (_, i) => event(`evt_${String(i).padStart(2, '0')}`, 'one_payment'));
  const replies = await Promise.all(payments.map((payment, i) => sender(i % 2 ? first : second, payment)));
  expect(replies.every(reply => reply.outcome === 'Processed')).toBe(true);
  expect(replies.filter(reply => reply.activationCreated)).toHaveLength(1);
  const stored = state();
  expect(stored.events.map(row => row.event_id)).toEqual(payments.map(payment => payment.eventId));
  expect(stored.events.every(row => row.state === 'completed')).toBe(true);
  expect(stored.events.filter(row => row.activation_created === 1)).toHaveLength(1);
  expect(stored.activations).toHaveLength(1);
  expect(stored.activations[0]?.payment_id).toBe('one_payment');
  expect(stored.events.find(row => row.activation_created === 1)?.event_id).toBe(stored.activations[0]?.event_id);
}, 35000);

it('handles 100 concurrent deliveries of 10 events distributed across two processes', async () => {
  const first = await server();
  const second = await server();
  const payments = Array.from({ length: 10 }, (_, i) => event(`mixed_${i}`));
  const replies = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    sender(i % 2 ? first : second, payments[Math.floor(i / 10)]!)));
  expect(replies.filter(reply => reply.outcome === 'Processed')).toHaveLength(10);
  expect(replies.filter(reply => reply.outcome === 'Duplicate')).toHaveLength(90);
  expect(state()).toEqual({
    events: payments.map(payment => ({ event_id: payment.eventId, state: 'completed', activation_created: 1 })),
    activations: payments.map(payment => ({ payment_id: payment.paymentId, event_id: payment.eventId })),
  });
}, 35000);

it('returns 503 under an independent writer lock, commits nothing, and succeeds after release', async () => {
  const url = await server();
  const locker = start('lock');
  await locker.waitFor('locked');
  const payment = event('locked_event');
  const response = await deliver(url, payment);
  expect(response).toEqual({ status: 503, body: { outcome: 'ProcessingFailed' } });
  expect(state()).toEqual({ events: [], activations: [] });
  locker.send({ type: 'release' });
  await locker.waitFor('released');
  expect(await sender(url, payment)).toEqual({ outcome: 'Processed', activationCreated: true });
  expect(state()).toEqual({
    events: [{ event_id: payment.eventId, state: 'completed', activation_created: 1 }],
    activations: [{ payment_id: payment.paymentId, event_id: payment.eventId }],
  });
}, 20000);

it('rejects an unexpected internal 503 instead of retrying it as contention', async () => {
  const url = await server();
  const worker = servers.get(url)!;
  worker.send({ type: 'inject', count: 1 });
  await worker.waitFor('configured');
  const payment = event('unexpected_failure');
  await expect(sender(url, payment)).rejects.toThrow('not proven SQLite contention');
  expect(state()).toEqual({ events: [], activations: [] });
  expect(await sender(url, payment)).toEqual({ outcome: 'Processed', activationCreated: true });
}, 20000);

it('fails after three confirmed contention responses with bounded sanitized diagnostics', async () => {
  const url = await server();
  const worker = servers.get(url)!;
  // Synthetic SQLITE_BUSY diagnoses test retry exhaustion without 15 seconds of lock waits.
  worker.send({ type: 'inject', count: 3, code: 5 });
  await worker.waitFor('configured');
  const payment = event('retry_exhaustion');
  await expect(sender(url, payment)).rejects.toThrow('Sender exhausted 3 attempts');
  expect(state()).toEqual({ events: [], activations: [] });
  expect(await sender(url, payment)).toEqual({ outcome: 'Processed', activationCreated: true });
}, 20000);

it('classifies extended SQLITE_LOCKED codes and retries only the diagnosed failure', async () => {
  const url = await server();
  const worker = servers.get(url)!;
  worker.send({ type: 'inject', count: 1, code: 262 }); // SQLITE_LOCKED_SHAREDCACHE primary code 6.
  await worker.waitFor('configured');
  const payment = event('classified_locked');
  expect(await sender(url, payment)).toEqual({ outcome: 'Processed', activationCreated: true });
  expect(state().activations).toEqual([{ payment_id: payment.paymentId, event_id: payment.eventId }]);
}, 20000);

it.each(['before', 'after'])('recovers after killing a child at the %s-COMMIT checkpoint', async point => {
  const worker = start('crash', point);
  await worker.waitFor('ready');
  const payment = event(`crash_${point}`);
  worker.send({ type: 'process', event: payment });
  const checkpoint = await worker.waitFor('checkpoint');
  expect(checkpoint.point).toBe(point);
  expect(checkpoint.transactionActive).toBe(point === 'before');
  expect(checkpoint.event).toEqual({ event_id: payment.eventId, state: 'completed' });
  expect(checkpoint.activation).toEqual({ payment_id: payment.paymentId, event_id: payment.eventId });
  await worker.stop(true); // SIGKILL targets only this child; no cleanup can run.
  if (point === 'before') expect(state()).toEqual({ events: [], activations: [] });
  const completed = {
    events: [{ event_id: payment.eventId, state: 'completed', activation_created: 1 }],
    activations: [{ payment_id: payment.paymentId, event_id: payment.eventId }],
  };
  if (point === 'after') expect(state()).toEqual(completed);
  const url = await server();
  expect(await sender(url, payment)).toEqual(point === 'before'
    ? { outcome: 'Processed', activationCreated: true } : { outcome: 'Duplicate' });
  expect(state()).toEqual(completed);
}, 20000);
