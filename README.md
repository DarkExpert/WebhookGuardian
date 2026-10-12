# Webhook Guardian Community v0.1.0

A small local mock webhook receiver: authenticate requests, persist event identity,
and prevent repeated local payment activations. No real payments or external APIs.

## Local setup

Requires **Node.js 24 LTS, 24.15.0 or newer within the 24.x line**, and npm.
Uses built-in `node:sqlite`; no native npm addon or separate database server is
needed. Node labels this API release candidate and may emit an experimental warning.
See the [Node 24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value into `MOCK_WEBHOOK_SECRET` in `.env`. This is a local
mock development secret. At least 32 UTF-8 bytes are required; generate random
values rather than choosing a password. `.env` and SQLite data files are ignored.
Whitespace-only secrets are rejected. The length check does not establish entropy
or guarantee cryptographic strength.

```powershell
npm run build
npm run typecheck
npm test
npm start
```

`npm start` loads `.env` and binds `127.0.0.1:3000`. Optional settings: `HOST`,
`PORT`, `DATABASE_PATH` (if absent, explicitly defaults to persistent
`./guardian.sqlite`). The executable requires a persistent SQLite file: empty or
whitespace-only paths, `:memory:`, and SQLite `file:` URIs are rejected with a
sanitized configuration error. No temporary-storage fallback is used. In-memory
storage in the application factory is intended for isolated automated tests only.
The database parent directory must exist. Startup fails for missing/short or
whitespace-only secrets, invalid ports or inaccessible
databases. SIGINT/SIGTERM close the application and database. Application logs and
HTTP responses do not expose secrets or internal exception details.

## Version 1 mock event

`POST /webhooks/mock-payment`, `Content-Type: application/json`:

```json
{
  "schemaVersion": "1",
  "eventId": "evt_demo_001",
  "eventType": "payment.completed",
  "occurredAt": "2026-10-12T12:00:00Z",
  "paymentId": "pay_demo_001"
}
```

All five fields are required; extra fields are rejected. IDs contain 1–128 ASCII
letters, digits, underscores or hyphens. `occurredAt` is an ISO date-time in UTC
with `Z`; fractional seconds are allowed. Event types match
`^[a-z][a-z0-9_.-]{0,63}$`. Only `payment.completed` activates a payment. Other
valid types are persisted as `unsupported` and return `UnsupportedEvent` on every
retry. Invalid requests are not persisted. Bodies must be valid UTF-8 JSON and
cannot exceed 16 KiB. Sample: `examples/payment-completed.v1.json`.

## Sign and send

Set `X-Mock-Signature: v1=<64 hexadecimal characters>`. The digest is HMAC-SHA256
with the configured secret over the **exact transmitted body bytes**. `v1` versions
the signature format; both hexadecimal cases are accepted. Missing, malformed and
incorrect signatures return the same generic response. Node's `timingSafeEqual`
compares digests after strict format/length validation. Authentication precedes JSON
parsing; body-size rejection can precede authentication.

After starting the receiver, use another terminal:

```powershell
node --env-file=.env scripts/send-mock.mjs
node --env-file=.env scripts/send-mock.mjs
```

The script signs the sample file bytes and sends those same bytes. First delivery
returns `Processed`, next `Duplicate`. Do not reserialize a body after signing.
This mock protocol is not a Stripe, Shopify or PayPal protocol.

## HTTP contract

Responses are JSON with `outcome`. Only `Processed` adds `activationCreated`.

| HTTP | Outcome | Meaning |
| --- | --- | --- |
| 200 | `Processed` | New event completed; `activationCreated: true` for a first payment activation, otherwise `false`. |
| 200 | `Duplicate` | Same event ID and validated content already completed. |
| 401 | `InvalidSignature` | Missing, malformed or incorrect signature. |
| 400 | `InvalidPayload` | Invalid JSON, UTF-8, schema or malformed body. |
| 413 | `InvalidPayload` | Body exceeds 16 KiB. |
| 415 | `InvalidPayload` | Content type is not application/json. |
| 409 | `EventConflict` | Existing event ID has different validated content. |
| 422 | `UnsupportedEvent` | Valid authenticated event type has no supported operation. |
| 503 | `ProcessingFailed` | Internal processing/storage failure; retry the identical event with backoff. |

Unknown routes use Fastify's normal 404. No database or crypto exception details
are returned. Example: `{"outcome":"Processed","activationCreated":true}`.

## Persistence, atomicity and recovery

`inbox.event_id` is a primary key; `payment_activations.payment_id` is another.
Each supported event uses a `BEGIN IMMEDIATE` transaction: check event identity,
insert inbox processing record, insert activation if absent, mark inbox completed,
commit. Different event IDs for the same payment complete with
`activationCreated: false`. All business effects stay inside SQLite.

SQLite serializes writers sharing the file, with a 5-second lock timeout. WAL and
`synchronous=FULL` are enabled. Identity compares canonical JSON of all validated
fields: whitespace/key order do not conflict; changed values (including timestamp
spelling) do. Unsupported event IDs also reserve identity and conflict on changes.
Persistence requires a suitable local filesystem with SQLite locking and sync
support. Network-shared SQLite deployments are outside the supported MVP scope.

Processing state is never committed independently. Exceptions roll back both inbox
and activation. An interruption before commit leaves neither change after SQLite
journal recovery; interruption after commit leaves both. A lost HTTP response can
be retried and return `Duplicate`. There is no durable queue or automatic background
retry: the sender retries failures. Lock timeouts return `ProcessingFailed`.
No ordinary path leaves a durable processing row. A manually corrupted/preexisting
processing row fails closed with 503 and requires database inspection.
Rollback is attempted only while a transaction remains active. If cleanup itself
fails, the original processing exception is preserved and the request still fails;
there is no automatic retry. Storage failures that prevent rollback may require an
application restart and database inspection.

Tests exercise signed HTTP behavior, raw bytes, validation, conflicts, concurrent
requests through two connections, business uniqueness, restart persistence, and a
SQLite trigger aborting completion after activation to prove full rollback.
WG-002 adds separate Node process tests for concurrent HTTP delivery and writer-lock
contention, plus controlled before/after-COMMIT child termination and restart tests.
Crash instrumentation exists only in a test harness; the production server has no
fault-injection switches or HTTP hooks. These tests terminate processes, not the
operating system or storage hardware. See [reliability details](docs/reliability.md).

## Python reliability demo

Python 3.9+ and its standard library are sufficient; no pip packages are needed.
Start Guardian with a persistent local database. In another terminal, set
`MOCK_WEBHOOK_SECRET` to the same development secret used by Guardian (the Python
script reads the environment and does not load `.env` automatically), then run:

```powershell
python examples/python-simulator/simulator.py --database ./guardian.sqlite
```

The defaults send 100 valid deliveries across 10 unique events using 8 workers,
plus one invalid signature. Totals are computed from actual responses. With
`--database`, completion records, content and activations for this run are checked
read-only; otherwise the summary explicitly says verification is API-only.
Each invocation creates a fresh event/payment namespace. Configure `--endpoint`,
`--events`, `--deliveries`, `--workers`, `--timeout` or `--retries` as needed; see
`--help` and [reliability documentation](docs/reliability.md). Failures exit nonzero.
Verification checks responses per submitted event and payment, so matching aggregate
totals cannot hide repeated processing of one event or missing processing of another.
Run the controlled-response regressions with:

```text
python -B -m unittest discover -s examples/python-simulator -v
```

The instrumented Node tests confirm SQLite lock error codes privately before retrying
a generic 503. Ordinary clients, including the Python simulator, cannot distinguish
lock contention from other internal failures through the public HTTP API.

## Scope and limitations

This demonstrates local transactional idempotency for one mock operation. It does
not claim production readiness or exactly-once delivery, and does not guarantee
exactly-once external side effects. SQLite is synchronous and
blocks the event loop. Deduplication lasts only while the database records are
retained. There is no retention cleanup, migration framework, backup tooling,
monitoring, dashboard, recovery worker, rate limiting, TLS termination, secret
rotation, replay-age check or external-effect guarantee. `occurredAt` is validated
but is not a trusted clock or freshness constraint. Protect the database and secret;
deleting data removes duplicate protection.

Planned commercial boundaries: real provider adapters, customer backend integrations,
advanced recovery, monitoring and cloud deployment. These are excluded from this
Community foundation, together with WG-003 and any frontend. WG-002 provides
reliability verification and a mock sender, without extending the product API.
