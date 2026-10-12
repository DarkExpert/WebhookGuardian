import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileServer, TestProcess } from './helpers/processes.js';

const children: TestProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.map(child => child.stop(true)));
  expect(children.every(child => child.closed)).toBe(true);
  children.length = 0;
});

async function parkedChild() {
  const child = new TestProcess(resolve('dist'), ':memory:', 'park', 'test-only-secret-at-least-32-bytes');
  children.push(child);
  await child.waitFor('ready');
  return child;
}

it('removes a partial build and rethrows the exact original compilation exception', () => {
  const original = new Error('original compiler failure');
  let directory: string | undefined;
  let caught: unknown;
  try {
    compileServer(path => { directory = path; expect(existsSync(path)).toBe(true); throw original; });
  } catch (error) { caught = error; }
  expect(caught).toBe(original);
  expect(directory).toBeDefined();
  expect(existsSync(directory!)).toBe(false);
});

it('terminates a parked test-owned process and confirms close', async () => {
  const child = await parkedChild();
  await child.stop(true);
  expect(child.closed).toBe(true);
});

it('forces termination when graceful shutdown cannot run in the parked child', async () => {
  const child = await parkedChild();
  await child.stop(false, 2000);
  expect(child.closed).toBe(true);
});

it('rejects at the teardown deadline when kill does not terminate the child, then cleans up', async () => {
  const child = await parkedChild();
  const kill = vi.spyOn(child.child, 'kill').mockReturnValue(true);
  try {
    await expect(child.stop(true, 50)).rejects.toThrow('teardown deadline');
    expect(child.closed).toBe(false);
  } finally {
    kill.mockRestore();
    await child.stop(true);
  }
  expect(child.closed).toBe(true);
});

it('closes its child after a primary failure without replacing that failure', async () => {
  const child = await parkedChild();
  const primary = new Error('primary test failure');
  let caught: unknown;
  try { throw primary; } catch (error) { caught = error; }
  finally { await child.stop(true); }
  expect(caught).toBe(primary);
  expect(child.closed).toBe(true);
});
