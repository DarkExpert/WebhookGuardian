import { buildApp } from './app.js';
import { requireSecret } from './security.js';

class ConfigurationError extends Error {}

function persistentDatabasePath(value: string | undefined): string {
  // Only an absent setting selects the documented persistent file default.
  const path = value ?? './guardian.sqlite';
  if (!path.trim() || path.trim().toLowerCase() === ':memory:' || /^file:/i.test(path.trim())) {
    throw new ConfigurationError('DATABASE_PATH must be a persistent local file path; empty paths, :memory:, and SQLite URIs are unsupported.');
  }
  return path;
}

async function main(): Promise<void> {
  const databasePath = persistentDatabasePath(process.env.DATABASE_PATH);
  const secret = requireSecret(process.env.MOCK_WEBHOOK_SECRET);
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const app = buildApp({ secret, databasePath });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
  }
  try {
    await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
    console.log('Webhook Guardian Community v0.1.0 listening');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  // Configuration and database exceptions can include sensitive paths or values.
  console.error(error instanceof ConfigurationError
    ? `Webhook Guardian startup failed. ${error.message}`
    : 'Webhook Guardian startup failed. Check local configuration and database access.');
  process.exitCode = 1;
});
