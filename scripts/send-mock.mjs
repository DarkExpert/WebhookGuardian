import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const secret = process.env.MOCK_WEBHOOK_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Configure MOCK_WEBHOOK_SECRET');
const body = await readFile(new URL('../examples/payment-completed.v1.json', import.meta.url));
const signature = `v1=${createHmac('sha256', secret).update(body).digest('hex')}`;
const response = await fetch('http://127.0.0.1:3000/webhooks/mock-payment', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
  body,
});
console.log(response.status, await response.text());
