import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const eventSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  eventId: identifier,
  eventType: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  occurredAt: z.iso.datetime(),
  paymentId: identifier,
});

export type PaymentEvent = z.infer<typeof eventSchema>;

// Explicit field order defines content equality after strict schema validation.
export function canonicalEvent(event: PaymentEvent): string {
  return JSON.stringify({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    paymentId: event.paymentId,
  });
}

export function activatePayment(db: DatabaseSync, event: PaymentEvent): boolean {
  const result = db.prepare(`
    INSERT INTO payment_activations (payment_id, event_id, occurred_at)
    VALUES (?, ?, ?) ON CONFLICT(payment_id) DO NOTHING
  `).run(event.paymentId, event.eventId, event.occurredAt);
  return result.changes === 1;
}
