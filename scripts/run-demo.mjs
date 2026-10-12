import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class DemoError extends Error {}

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DemoError(`${label} timed out.`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function ownedChild(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const state = { child, closed: false, failed: false, stdout: '', overflow: false };
  child.on('error', () => { state.failed = true; });
  child.stdout?.on('data', chunk => {
    if (state.stdout.length + chunk.length > 65536) state.overflow = true;
    state.stdout = (state.stdout + String(chunk)).slice(0, 65536);
  });
  // Drain stderr, but don't disclose arbitrary runtime paths/configuration values.
  child.stderr?.on('data', () => {});
  state.exit = new Promise(done => child.once('close', (code, signal) => {
    state.closed = true;
    done({ code, signal });
  }));
  state.stop = async () => {
    if (state.closed) return;
    let escalation;
    try {
      if (child.connected) child.send({ type: 'stop' }, () => {});
      else child.kill('SIGKILL');
      escalation = setTimeout(() => {
        if (!state.closed) { try { child.kill('SIGKILL'); } catch { state.failed = true; } }
      }, 1000);
      await bounded(state.exit, 5000, 'Owned child cleanup');
    } catch { throw new DemoError('Owned child cleanup failed; temporary resources were retained.'); }
    finally { clearTimeout(escalation); }
  };
  return state;
}

async function pythonCommand(children) {
  const choices = process.env.PYTHON ? [[process.env.PYTHON]]
    : [['python3'], ['python'], ...(process.platform === 'win32' ? [['py', '-3']] : [])];
  for (const choice of choices) {
    const probe = ownedChild(choice[0], [...choice.slice(1), '--version']);
    children.push(probe);
    try {
      const result = await bounded(probe.exit, 3000, 'Python discovery');
      const version = /^Python 3\.(\d+)\./.exec(probe.stdout.trim());
      if (!probe.failed && result.code === 0 && version && Number(version[1]) >= 9) return choice;
    } finally { await probe.stop(); }
  }
  throw new DemoError('Python 3.9+ was not found. Install Python or set PYTHON to its executable path.');
}

function verifySummary(output) {
  for (const [label, expected] of Object.entries({ Deliveries: 100, 'Unique Event IDs': 10,
    'Processed Events': 10, 'Duplicate Deliveries': 90, 'Business Activations': 10,
    'Rejected Invalid Signatures': 1 })) {
    const matches = [...output.matchAll(new RegExp(`^${label}: (\\d+)\\r?$`, 'gm'))];
    if (matches.length !== 1 || Number(matches[0][1]) !== expected) {
      throw new DemoError('Simulator result totals did not match the demo assertions.');
    }
  }
  if (!/^State Verification: SQLite verified \(this run only\)\r?$/m.test(output) ||
      !/^Verification: PASS\r?$/m.test(output)) throw new DemoError('Simulator did not confirm persisted state.');
}

function verifyPersistence(database, runId) {
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    const events = reader.prepare('SELECT event_id, content, state, activation_created FROM inbox').all();
    const activations = reader.prepare('SELECT payment_id, event_id FROM payment_activations').all();
    if (events.length !== 10 || activations.length !== 10) throw new DemoError('Persisted row counts are incorrect.');
    for (let i = 0; i < 10; i++) {
      const eventId = `demo_${runId}_${i}`;
      const paymentId = `payment_${runId}_${i}`;
      const row = events.find(event => event.event_id === eventId);
      const content = row && JSON.parse(row.content);
      if (!row || row.state !== 'completed' || row.activation_created !== 1 ||
          content.schemaVersion !== '1' || content.eventType !== 'payment.completed' ||
          content.eventId !== eventId || content.paymentId !== paymentId ||
          !activations.some(activation => activation.payment_id === paymentId && activation.event_id === eventId)) {
        throw new DemoError('Persisted event identities or activation states are incorrect.');
      }
    }
  } finally { reader.close(); }
}

const children = [];
let directory;
let output;
let failure;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  for (const owned of children) if (!owned.closed) {
    try { owned.child.kill('SIGKILL'); } catch { owned.failed = true; }
  }
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  directory = await mkdtemp(join(tmpdir(), 'guardian-demo-'));
  const database = join(directory, 'guardian.sqlite');
  const secret = randomBytes(32).toString('hex');
  const runId = randomBytes(16).toString('hex');
  const server = ownedChild(process.execPath, [join(root, 'scripts/demo-server.mjs'), database], {
    env: { ...process.env, MOCK_WEBHOOK_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(server);
  const ready = await bounded(Promise.race([
    new Promise(done => server.child.once('message', done)),
    server.exit.then(() => { throw new DemoError('Guardian demo server exited before readiness.'); }),
  ]), 15000, 'Guardian startup');
  if (ready?.type !== 'ready' || typeof ready.url !== 'string') throw new DemoError('Invalid Guardian readiness signal.');
  const url = new URL(ready.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new DemoError('Guardian did not bind a loopback port.');
  const python = await pythonCommand(children);
  if (interrupted) throw new DemoError('Interrupted.');
  const simulator = ownedChild(python[0], [...python.slice(1), '-B',
    join(root, 'examples/python-simulator/simulator.py'), '--endpoint', `${url.origin}/webhooks/mock-payment`,
    '--database', database, '--run-id', runId, '--events', '10', '--deliveries', '100',
    '--workers', '8', '--timeout', '10', '--retries', '2'], {
    env: { ...process.env, MOCK_WEBHOOK_SECRET: secret },
  });
  children.push(simulator);
  const result = await bounded(simulator.exit, 60000, 'Python simulator');
  if (simulator.failed || simulator.overflow || result.code !== 0) throw new DemoError('Python simulator failed its HTTP or SQLite verification.');
  verifySummary(simulator.stdout);
  await server.stop();
  if (server.failed || (await server.exit).code !== 0) throw new DemoError('Guardian demo server did not shut down cleanly.');
  verifyPersistence(database, runId);
  output = simulator.stdout.trim();
} catch (error) {
  failure = error instanceof DemoError ? error.message : 'Local runtime or filesystem verification failed.';
} finally {
  const stopped = await Promise.allSettled(children.map(child => child.stop()));
  if (stopped.some(result => result.status === 'rejected') || children.some(child => !child.closed)) {
    failure = `${failure ? failure + ' ' : ''}Cleanup failed; temporary resources were retained.`;
    for (const owned of children) if (!owned.closed) {
      // Do not let failed termination keep the runner alive indefinitely.
      try { if (owned.child.connected) owned.child.disconnect(); } catch {}
      owned.child.stdout?.destroy();
      owned.child.stderr?.destroy();
      owned.child.unref();
    }
  } else if (directory) {
    try { await bounded(rm(directory, { recursive: true, force: true, maxRetries: 2 }), 5000, 'Temporary resource cleanup'); }
    catch { failure = `${failure ? failure + ' ' : ''}Temporary resource cleanup failed.`; }
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
if (failure || interrupted) {
  console.error(`Demo failed: ${failure ?? 'Interrupted.'}`);
  process.exitCode = 1;
} else {
  console.log(output);
  console.log('Persistence: 10 completed inbox rows and 10 activation rows verified after server exit');
  console.log('Cleanup: PASS');
}
