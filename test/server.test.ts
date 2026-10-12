import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';

const secret = 'startup-test-only-secret-with-at-least-32-bytes';
let outputDirectory: string;
let directory: string;
let executable: string;
let child: ChildProcess | undefined;

beforeAll(() => {
  // Compile into an isolated, ignored directory with normal dependency resolution.
  // npm test therefore exercises the current executable without requiring a prior build.
  outputDirectory = mkdtempSync(resolve('node_modules', '.guardian-startup-'));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    '-p', resolve('tsconfig.json'), '--outDir', outputDirectory], { timeout: 30000 });
  executable = join(outputDirectory, 'server.js');
}, 35000);
afterAll(() => { rmSync(outputDirectory, { recursive: true, force: true }); });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'guardian-startup-')); });
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  child = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function environment(databasePath: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MOCK_WEBHOOK_SECRET: secret, HOST: '127.0.0.1', PORT: '3000' };
  delete env.DATABASE_PATH;
  if (databasePath !== undefined) env.DATABASE_PATH = databasePath;
  return env;
}

it.each(['', '   ', '\t\r\n', ':memory:', ' :memory: ',
  'file::memory:?cache=shared', 'file:temporary?mode=memory'])('rejects nonpersistent executable DATABASE_PATH %j', value => {
  const result = spawnSync(process.execPath, [executable], {
    cwd: directory, env: environment(value), encoding: 'utf8', timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('listening');
  expect(result.stderr).toContain('DATABASE_PATH must be a persistent local file path');
  expect(result.stderr).not.toContain(secret);
  expect(existsSync(join(directory, 'guardian.sqlite'))).toBe(false);
});

async function availablePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
  return address.port;
}

it.each([false, true])('starts with a persistent path (documented default: %s)', async useDefault => {
  const port = await availablePort();
  const databasePath = join(directory, useDefault ? 'guardian.sqlite' : 'explicit.sqlite');
  child = spawn(process.execPath, [executable], {
    cwd: directory, env: { ...environment(useDefault ? undefined : databasePath), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = child;
  let stderr = '';
  server.stderr?.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Server readiness timeout')), 10000);
    let stdout = '';
    server.stdout?.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('listening')) { clearTimeout(timer); done(); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${stderr}`)); });
  });
  const payload = JSON.stringify({ schemaVersion: '1', eventId: 'evt_startup',
    eventType: 'payment.completed', occurredAt: '2026-10-12T12:00:00Z', paymentId: 'pay_startup' });
  const signature = `v1=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/mock-payment`, {
    method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: 'Processed', activationCreated: true });
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(reader.prepare('SELECT state FROM inbox WHERE event_id = ?').get('evt_startup')?.state).toBe('completed');
    expect(reader.prepare('SELECT count(*) n FROM payment_activations').get()?.n).toBe(1);
  } finally { reader.close(); }
}, 15000);
