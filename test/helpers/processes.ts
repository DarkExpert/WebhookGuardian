import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export function compileServer(compile = (directory: string) => {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    '-p', resolve('tsconfig.json'), '--outDir', directory], { timeout: 30000 });
}): string {
  const directory = mkdtempSync(resolve('node_modules', '.guardian-reliability-'));
  try {
    compile(directory);
    return directory;
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { console.error('Test build cleanup failed after compilation failure.'); }
    throw error;
  }
}

export interface Signal {
  type: string;
  url?: string;
  pid?: number;
  point?: string;
  transactionActive?: boolean;
  event?: { event_id: string; state: string };
  activation?: { payment_id: string; event_id: string };
  message?: string;
  requestId?: string;
  kind?: 'contention' | 'unexpected';
  sqliteCode?: number | null;
}

export class TestProcess {
  readonly child: ChildProcess;
  private readonly signals: Signal[] = [];
  private readonly listeners = new Set<() => void>();
  private stderr = '';
  private failure: Error | undefined;
  private readonly exited: Promise<void>;
  private hasExited = false;

  constructor(compiled: string, database: string, mode: string, secret: string, point = '') {
    this.child = spawn(process.execPath, [resolve('test/helpers/reliability-worker.mjs'),
      compiled, database, mode, point], {
      env: { ...process.env, MOCK_WEBHOOK_SECRET: secret },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let buffer = '';
    this.child.stdout?.on('data', chunk => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { this.signals.push(JSON.parse(line) as Signal); }
        catch { this.failure = new Error('Invalid child synchronization message'); }
      }
      this.wake();
    });
    this.child.stderr?.on('data', chunk => { this.stderr += String(chunk); });
    this.child.on('error', error => { this.failure = error; this.wake(); });
    this.exited = new Promise(done => {
      this.child.once('close', () => { this.hasExited = true; this.wake(); done(); });
    });
  }

  private wake(): void { for (const listener of this.listeners) listener(); }

  waitFor(type: string, timeout = 10000, requestId?: string): Promise<Signal> {
    return new Promise((done, reject) => {
      const finish = (error?: Error, signal?: Signal) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        if (error) reject(error);
        else if (signal) done(signal);
      };
      const check = () => {
        const index = this.signals.findIndex(signal => signal.type === type &&
          (requestId === undefined || signal.requestId === requestId));
        if (index >= 0) return finish(undefined, this.signals.splice(index, 1)[0]);
        const fatal = this.signals.find(signal => signal.type === 'fatal');
        if (fatal || this.failure || this.hasExited) {
          finish(this.failure ?? new Error(fatal?.message ?? `Child exited before ${type}: ${this.stderr}`));
        }
      };
      const timer = setTimeout(() => finish(new Error(`Child timed out waiting for ${type}: ${this.stderr}`)), timeout);
      this.listeners.add(check);
      check();
    });
  }

  send(message: object): void {
    if (!this.child.connected) throw new Error('Child IPC is disconnected');
    this.child.send(message);
  }

  get closed(): boolean { return this.hasExited; }

  async stop(abrupt = false, deadline = 5000): Promise<void> {
    if (!Number.isFinite(deadline) || deadline <= 0) throw new Error('Invalid child teardown deadline');
    if (this.hasExited) return;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_done, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error('Test-owned child did not close before teardown deadline')), deadline);
      if (!abrupt) forceTimer = setTimeout(() => {
        if (!this.hasExited) {
          try { this.child.kill('SIGKILL'); }
          catch { reject(new Error('Failed to terminate test-owned child')); }
        }
      }, deadline / 2);
    });
    try {
      if (abrupt || !this.child.connected) this.child.kill('SIGKILL');
      else this.send({ type: 'stop' });
      await Promise.race([this.exited, expired]);
    } catch {
      throw new Error('Test-owned child termination failed or exceeded teardown deadline');
    } finally {
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
    }
  }
}
