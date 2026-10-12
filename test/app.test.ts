import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp, BODY_LIMIT } from '../src/app.js';

const secret = 'test-only-secret-with-at-least-32-bytes';
const event = { schemaVersion: '1', eventId: 'evt_1', eventType: 'payment.completed',
  occurredAt: '2026-10-12T12:00:00Z', paymentId: 'pay_1' };
type App = ReturnType<typeof buildApp>;
let directory: string;
let path: string;
let apps: App[];
function open() {
  const app = buildApp({ secret, databasePath: path });
  apps.push(app);
  return app;
}
function sign(body: string | Buffer) {
  return `v1=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
function send(app: App, payload = JSON.stringify(event), signature = sign(payload)) {
  return app.inject({ method: 'POST', url: '/webhooks/mock-payment', payload,
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature } });
}
function counts() {
  const db = new DatabaseSync(path);
  try {
    return {
      inbox: db.prepare('SELECT count(*) AS n FROM inbox').get()?.n,
      activations: db.prepare('SELECT count(*) AS n FROM payment_activations').get()?.n,
      processing: db.prepare("SELECT count(*) AS n FROM inbox WHERE state = 'processing'").get()?.n,
    };
  } finally { db.close(); }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'guardian-test-'));
  path = join(directory, 'inbox.sqlite');
  apps = [];
});
afterEach(async () => {
  await Promise.all(apps.map(app => app.close()));
  rmSync(directory, { recursive: true, force: true });
});

it('processes a valid signed request and completes one activation', async () => {
  const response = await send(open());
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ outcome: 'Processed', activationCreated: true });
  expect(counts()).toEqual({ inbox: 1, activations: 1, processing: 0 });
});
it('rejects missing signature without storing data', async () => {
  const response = await open().inject({ method: 'POST', url: '/webhooks/mock-payment', payload: event });
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ outcome: 'InvalidSignature' });
  expect(counts().inbox).toBe(0);
});
it.each(['', 'v1=bad', `v1=${'0'.repeat(64)}`, `v2=${'a'.repeat(64)}`])(
  'rejects malformed/incorrect signature %s', async signature => {
    const response = await send(open(), JSON.stringify(event), signature);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ outcome: 'InvalidSignature' });
    expect(counts().inbox).toBe(0);
  });
it('verifies exact raw bytes and accepts correctly signed formatted JSON', async () => {
  const app = open();
  const body = JSON.stringify(event, null, 2) + '\n';
  expect((await send(app, body, sign(JSON.stringify(event)))).statusCode).toBe(401);
  expect((await send(app, body)).json().outcome).toBe('Processed');
  const unicode = JSON.stringify({ ...event, paymentId: 'pay_é' });
  expect((await send(app, unicode, sign(unicode.replace('é', 'e')))).statusCode).toBe(401);
});
it.each(['{', 'null', JSON.stringify({ eventId: 'evt_1' }),
  JSON.stringify({ ...event, eventId: '' }), JSON.stringify({ ...event, schemaVersion: '2' }),
  JSON.stringify({ ...event, occurredAt: 'yesterday' }), JSON.stringify({ ...event, extra: true })])(
  'rejects invalid payload %s', async payload => {
    const response = await send(open(), payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ outcome: 'InvalidPayload' });
    expect(counts().inbox).toBe(0);
  });
it('rejects correctly signed invalid UTF-8', async () => {
  const payload = Buffer.from([0xff]);
  const response = await open().inject({ method: 'POST', url: '/webhooks/mock-payment', payload,
    headers: { 'content-type': 'application/json', 'x-mock-signature': sign(payload) } });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ outcome: 'InvalidPayload' });
});
it('enforces body size limit', async () => {
  const response = await send(open(), ' '.repeat(BODY_LIMIT + 1));
  expect(response.statusCode).toBe(413);
  expect(response.json()).toEqual({ outcome: 'InvalidPayload' });
});
it('requires JSON content type', async () => {
  const payload = JSON.stringify(event);
  const response = await open().inject({ method: 'POST', url: '/webhooks/mock-payment', payload,
    headers: { 'content-type': 'text/plain', 'x-mock-signature': sign(payload) } });
  expect(response.statusCode).toBe(415);
  expect(response.json()).toEqual({ outcome: 'InvalidPayload' });
});
it('deduplicates equivalent JSON formatting and key order', async () => {
  const app = open();
  await send(app);
  const body = JSON.stringify({ paymentId: event.paymentId, occurredAt: event.occurredAt,
    eventType: event.eventType, eventId: event.eventId, schemaVersion: '1' }, null, 2);
  const response = await send(app, body);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ outcome: 'Duplicate' });
  expect(counts()).toEqual({ inbox: 1, activations: 1, processing: 0 });
});
it.each([{ paymentId: 'pay_2' }, { occurredAt: '2026-10-13T12:00:00Z' },
  { eventType: 'payment.failed' }])('rejects conflicting identity %j', async change => {
    const app = open();
    await send(app);
    const response = await send(app, JSON.stringify({ ...event, ...change }));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ outcome: 'EventConflict' });
    expect(counts().activations).toBe(1);
  });
it('handles concurrent duplicates through two database connections', async () => {
  const first = open();
  const second = open();
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => send(i % 2 ? first : second)));
  expect(responses.every(response => response.statusCode === 200)).toBe(true);
  expect(responses.filter(response => response.json().outcome === 'Processed')).toHaveLength(1);
  expect(responses.filter(response => response.json().outcome === 'Duplicate')).toHaveLength(19);
  expect(counts()).toEqual({ inbox: 1, activations: 1, processing: 0 });
});
it('prevents repeated business activation with different event IDs', async () => {
  const app = open();
  await send(app);
  expect((await send(app, JSON.stringify({ ...event, eventId: 'evt_2' }))).json())
    .toEqual({ outcome: 'Processed', activationCreated: false });
  expect(counts()).toEqual({ inbox: 2, activations: 1, processing: 0 });
});
it('persists deduplication across application restart', async () => {
  const app = open();
  await send(app);
  await app.close();
  apps = [];
  expect((await send(open())).json()).toEqual({ outcome: 'Duplicate' });
  expect(counts()).toEqual({ inbox: 1, activations: 1, processing: 0 });
});
it('persists unsupported identity and returns explicit failure on retries', async () => {
  const app = open();
  const payload = JSON.stringify({ ...event, eventType: 'payment.failed' });
  for (let i = 0; i < 2; i++) {
    const response = await send(app, payload);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ outcome: 'UnsupportedEvent' });
  }
  expect((await send(app)).statusCode).toBe(409);
  expect(counts()).toEqual({ inbox: 1, activations: 0, processing: 0 });
});
it('rolls back activation and inbox after completion failure, allowing retry', async () => {
  const app = open();
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TRIGGER simulate_failure BEFORE UPDATE ON inbox
      WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'private database failure'); END;`);
    const response = await send(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ outcome: 'ProcessingFailed' });
    expect(response.body).not.toContain('private database failure');
    expect(counts()).toEqual({ inbox: 0, activations: 0, processing: 0 });
    db.exec('DROP TRIGGER simulate_failure');
    expect((await send(app)).json()).toEqual({ outcome: 'Processed', activationCreated: true });
    expect(counts()).toEqual({ inbox: 1, activations: 1, processing: 0 });
  } finally { db.close(); }
});
it.each(['', 'short', ' '.repeat(32), '\t\r\n'.repeat(12), '\u2003'.repeat(32)])('fails startup with absent/invalid secret %s', value => {
  expect(() => buildApp({ secret: value, databasePath: path })).toThrow(/MOCK_WEBHOOK_SECRET/);
});

it('preserves in-memory storage support in the application factory', async () => {
  const app = buildApp({ secret, databasePath: ':memory:' });
  apps.push(app);
  expect((await send(app)).json()).toEqual({ outcome: 'Processed', activationCreated: true });
  expect((await send(app)).json()).toEqual({ outcome: 'Duplicate' });
});
