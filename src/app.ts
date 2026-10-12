import Fastify, { type FastifyError } from 'fastify';
import { TextDecoder } from 'node:util';
import { Inbox } from './inbox.js';
import { eventSchema } from './handler.js';
import { requireSecret, verifySignature } from './security.js';

export interface AppOptions { secret: string; databasePath: string }
export const BODY_LIMIT = 16 * 1024;

export function buildApp(options: AppOptions) {
  const secret = requireSecret(options.secret);
  const inbox = new Inbox(options.databasePath);
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: false });
  app.addHook('onClose', async () => { inbox.close(); });

  // Preserve bytes; JSON decoding happens only after authentication.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ outcome: 'InvalidPayload' });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(400).send({ outcome: 'InvalidPayload' });
    }
    return reply.code(503).send({ outcome: 'ProcessingFailed' });
  });

  app.post('/webhooks/mock-payment', async (request, reply) => {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!verifySignature(body, request.headers['x-mock-signature'], secret)) {
      return reply.code(401).send({ outcome: 'InvalidSignature' });
    }
    const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return reply.code(415).send({ outcome: 'InvalidPayload' });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return reply.code(400).send({ outcome: 'InvalidPayload' });
    }
    const parsed = eventSchema.safeParse(decoded);
    if (!parsed.success) return reply.code(400).send({ outcome: 'InvalidPayload' });
    const result = inbox.process(parsed.data);
    const status = { Processed: 200, Duplicate: 200, EventConflict: 409, UnsupportedEvent: 422 };
    return reply.code(status[result.outcome]).send(result);
  });
  return app;
}
