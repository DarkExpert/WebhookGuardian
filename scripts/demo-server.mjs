// Demo entry point: the unchanged Guardian app, isolated by the parent runner.
import { buildApp } from '../dist/app.js';

let app;
let closing = false;
try {
  if (!process.connected || !process.argv[2]) throw new Error('Missing demo parent configuration');
  app = buildApp({ secret: process.env.MOCK_WEBHOOK_SECRET, databasePath: process.argv[2] });
  process.on('message', async message => {
    if (message?.type === 'stop') {
      if (closing) return;
      closing = true;
      try { await app.close(); }
      catch { process.exitCode = 1; }
      finally { if (process.connected) process.disconnect(); }
    }
  });
  process.on('disconnect', () => {
    if (!closing) { closing = true; void app.close().catch(() => { process.exitCode = 1; }); }
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ type: 'ready', url });
} catch {
  console.error('Guardian demo server failed to start. Check the build and local SQLite runtime.');
  process.exitCode = 1;
  if (app) await app.close().catch(() => {});
  if (process.connected) process.disconnect();
}
