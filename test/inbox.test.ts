import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, constants } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/inbox.js';
import type { PaymentEvent } from '../src/handler.js';

const event: PaymentEvent = { schemaVersion: '1', eventId: 'evt_transaction',
  eventType: 'payment.completed', occurredAt: '2026-10-12T12:00:00Z', paymentId: 'pay_transaction' };
let directory: string;
let path: string;
let inbox: Inbox;
let connection: DatabaseSync;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'guardian-transaction-'));
  path = join(directory, 'inbox.sqlite');
  // Capture the real SQLite connection without exposing production test hooks.
  const originalExec = DatabaseSync.prototype.exec;
  const capture = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    connection = this;
    return originalExec.call(this, sql);
  });
  try { inbox = new Inbox(path); } finally { capture.mockRestore(); }
});
afterEach(() => {
  vi.restoreAllMocks();
  connection.setAuthorizer(null);
  if (connection.isTransaction) connection.exec('ROLLBACK');
  inbox.close();
  rmSync(directory, { recursive: true, force: true });
});

function persistedState() {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      events: reader.prepare('SELECT event_id, state, activation_created FROM inbox').all(),
      activations: reader.prepare('SELECT payment_id, event_id FROM payment_activations').all(),
    };
  } finally { reader.close(); }
}

it('fails on a real SQLite commit denial, rolls back both mutations, and permits retry', () => {
  connection.setAuthorizer((action, argument) =>
    action === constants.SQLITE_TRANSACTION && argument === 'COMMIT'
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
  expect(() => inbox.process(event)).toThrow();
  expect(connection.isTransaction).toBe(false);
  expect(persistedState()).toEqual({ events: [], activations: [] });
  connection.setAuthorizer(null);
  expect(inbox.process(event)).toEqual({ outcome: 'Processed', activationCreated: true });
  expect(persistedState()).toEqual({
    events: [{ event_id: event.eventId, state: 'completed', activation_created: 1 }],
    activations: [{ payment_id: event.paymentId, event_id: event.eventId }],
  });
});

it('preserves the original exception when rollback cleanup also fails', () => {
  const originalError = new Error('original commit failure');
  const cleanupError = new Error('secondary rollback failure');
  const originalExec = DatabaseSync.prototype.exec;
  const fault = vi.spyOn(connection, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'COMMIT') throw originalError;
    if (sql === 'ROLLBACK') throw cleanupError;
    return originalExec.call(this, sql);
  });
  let caught: unknown;
  try { inbox.process(event); } catch (error) { caught = error; }
  expect(caught).toBe(originalError);
  expect(connection.isTransaction).toBe(true);
  // A separate connection must see no committed business or inbox mutations.
  expect(persistedState()).toEqual({ events: [], activations: [] });
  fault.mockRestore();
  connection.exec('ROLLBACK');
  expect(persistedState()).toEqual({ events: [], activations: [] });
});

it('preserves a SQLite failure after automatic transaction rollback', () => {
  connection.exec(`CREATE TRIGGER automatic_rollback BEFORE UPDATE ON inbox
    WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ROLLBACK, 'original processing failure'); END;`);
  const observe = vi.spyOn(connection, 'exec');
  expect(() => inbox.process(event)).toThrow('original processing failure');
  expect(connection.isTransaction).toBe(false);
  expect(observe.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
  expect(persistedState()).toEqual({ events: [], activations: [] });
  connection.exec('DROP TRIGGER automatic_rollback');
  expect(inbox.process(event)).toEqual({ outcome: 'Processed', activationCreated: true });
});
