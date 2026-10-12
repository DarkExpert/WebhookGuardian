// Test-only process harness. Never imported by src/ or emitted in the server build.
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const [compiledDirectory, databasePath, mode, crashPoint] = process.argv.slice(2);
const signal = (type, details = {}) => writeSync(1, JSON.stringify({ type, ...details }) + '\n');
const park = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

try {
  if (mode === 'server') {
    const { buildApp } = await import(pathToFileURL(join(compiledDirectory, 'app.js')).href);
    const { Inbox } = await import(pathToFileURL(join(compiledDirectory, 'inbox.js')).href);
    const requestContext = new AsyncLocalStorage();
    let injected;
    const originalProcess = Inbox.prototype.process;
    Inbox.prototype.process = function (event) {
      try {
        if (injected?.remaining > 0) {
          injected.remaining--;
          throw Object.assign(new Error('Test-only processing failure'), { errcode: injected.code });
        }
        return originalProcess.call(this, event);
      } catch (error) {
        const code = Number.isInteger(error?.errcode) ? error.errcode & 255 : null;
        signal('processing-error', { requestId: requestContext.getStore(), sqliteCode: code,
          kind: code === 5 || code === 6 ? 'contention' : 'unexpected' });
        throw error; // The unchanged app still emits only generic ProcessingFailed.
      }
    };
    const app = buildApp({ secret: process.env.MOCK_WEBHOOK_SECRET, databasePath });
    app.addHook('preHandler', (request, _reply, done) => {
      requestContext.run(request.headers['x-test-request-id'], done);
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    process.on('message', async message => {
      if (message?.type === 'stop') {
        await app.close();
        process.disconnect();
      } else if (message?.type === 'inject') {
        injected = { code: message.code, remaining: message.count };
        signal('configured');
      }
    });
    signal('ready', { url, pid: process.pid });
  } else if (mode === 'park') {
    signal('ready', { pid: process.pid });
    park();
  } else if (mode === 'lock') {
    const db = new DatabaseSync(databasePath, { timeout: 5000 });
    db.exec('BEGIN IMMEDIATE');
    process.on('message', message => {
      if (message?.type === 'release') {
        db.exec('ROLLBACK');
        db.close();
        signal('released');
        process.disconnect();
      }
    });
    signal('locked', { pid: process.pid });
  } else if (mode === 'crash' && ['before', 'after'].includes(crashPoint)) {
    const { Inbox } = await import(pathToFileURL(join(compiledDirectory, 'inbox.js')).href);
    const inbox = new Inbox(databasePath);
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'COMMIT' && crashPoint === 'before') {
        signal('checkpoint', {
          point: 'before', transactionActive: this.isTransaction,
          event: this.prepare('SELECT event_id, state FROM inbox').get(),
          activation: this.prepare('SELECT payment_id, event_id FROM payment_activations').get(),
        });
        park(); // No event loop, COMMIT, cleanup, or signal handler can run.
      }
      const result = originalExec.call(this, sql);
      if (sql === 'COMMIT' && crashPoint === 'after') {
        signal('checkpoint', {
          point: 'after', transactionActive: this.isTransaction,
          event: this.prepare('SELECT event_id, state FROM inbox').get(),
          activation: this.prepare('SELECT payment_id, event_id FROM payment_activations').get(),
        });
        park(); // COMMIT returned successfully, but process() has not returned.
      }
      return result;
    };
    process.once('message', message => {
      if (message?.type !== 'process') throw new Error('Unexpected crash harness command');
      inbox.process(message.event);
      throw new Error('Crash checkpoint was not reached');
    });
    signal('ready', { pid: process.pid });
  } else {
    throw new Error('Unknown reliability harness mode');
  }
} catch (error) {
  signal('fatal', { message: error instanceof Error ? error.message : 'Worker failed' });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
