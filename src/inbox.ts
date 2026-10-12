import { DatabaseSync } from 'node:sqlite';
import { activatePayment, canonicalEvent, type PaymentEvent } from './handler.js';

export type Outcome = 'Processed' | 'Duplicate' | 'EventConflict' | 'UnsupportedEvent';
export interface Result { outcome: Outcome; activationCreated?: boolean }

export class Inbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS inbox (
          event_id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('processing', 'completed', 'unsupported')),
          activation_created INTEGER CHECK(activation_created IN (0, 1)),
          received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS payment_activations (
          payment_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES inbox(event_id),
          occurred_at TEXT NOT NULL
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  process(event: PaymentEvent): Result {
    const content = canonicalEvent(event);
    // Serialize writers across connections/processes before checking identity.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT content, state FROM inbox WHERE event_id = ?')
        .get(event.eventId);
      let result: Result;
      if (previous) {
        if (previous.content !== content) result = { outcome: 'EventConflict' };
        else if (previous.state === 'unsupported') result = { outcome: 'UnsupportedEvent' };
        else if (previous.state === 'completed') result = { outcome: 'Duplicate' };
        else throw new Error('Unexpected persisted processing state');
      } else if (event.eventType !== 'payment.completed') {
        this.db.prepare("INSERT INTO inbox (event_id, content, state) VALUES (?, ?, 'unsupported')")
          .run(event.eventId, content);
        result = { outcome: 'UnsupportedEvent' };
      } else {
        this.db.prepare("INSERT INTO inbox (event_id, content, state) VALUES (?, ?, 'processing')")
          .run(event.eventId, content);
        const activationCreated = activatePayment(this.db, event);
        this.db.prepare(`UPDATE inbox SET state = 'completed', activation_created = ?,
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE event_id = ?`)
          .run(activationCreated ? 1 : 0, event.eventId);
        result = { outcome: 'Processed', activationCreated };
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch {
        // Cleanup must not replace the original processing or commit failure.
      }
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
