# Webhook Guardian Community v0.1.0 — draft release notes

**Prepared for review; not tagged or published.**

This first Community version accepts authenticated mock payment events and prevents
repeated local SQLite payment activations. It is intentionally narrow: no real
payments, provider integrations or external backend effects.

## Included

- POST /webhooks/mock-payment with a documented version-1 schema.
- Exact-byte HMAC-SHA256 authentication and timing-safe digest comparison.
- Strict payload/configuration validation and a 16 KiB request limit.
- Persistent event identity, content conflicts and processing outcomes.
- A unique payment business key and atomic activation/inbox completion transaction.
- Separate-process concurrency, lock contention and before/after-COMMIT crash tests.
- A dependency-free Python sender that verifies responses per event/payment and can
  independently inspect stored SQLite state.
- `npm run demo`: fresh temporary database, generated secret, real HTTP server child,
  100 deliveries for 10 events, invalid-signature rejection and cleanup.
- Ubuntu GitHub Actions CI with official actions pinned to immutable SHAs.

## Setup

Use Node.js 24.15+ within Node 24 LTS, npm, and Python 3.9+ for the demo. Run `npm ci`
then `npm run demo`. The normal server uses `.env`; its manual setup and HTTP
contract are in the [README](../README.md). Built-in SQLite is release candidate
in the supported Node range. Use persistent local storage, not a network share.

## Verification before publication

Run the full [CI workflow](../.github/workflows/ci.yml) and the documented checks in
[reliability.md](reliability.md). Verify both success and failure cleanup paths.
Windows and Ubuntu WSL results do not replace the first hosted GitHub Actions run.
No hosted CI success or release publication is claimed by these draft notes.

Fresh WG-003 checks on 2026-10-12 passed on Windows and Ubuntu 24.04 WSL using
Node.js 24.19.0: npm ci, build, typecheck, 58 Node tests, nine Python regressions,
npm audit (zero reported vulnerabilities), and npm run demo. Both demo runs
reported 100 deliveries, 10 Processed, 90 Duplicate, 10 persisted activations and
one rejected invalid signature. The parent verified 10 completed inbox rows and
10 activation rows after server exit. Unavailable-Python failure checks returned
1 and removed their temporary resources; no owned demo/reliability workers remained.

## Known limits

SQLite execution blocks the event loop. Senders handle retries; generic 503 responses
do not disclose the internal failure cause. Deduplication depends on retained data.
There is no TLS termination, rate limiting, retention/backup tooling, secret rotation,
replay-age check, dashboard or recovery queue. Process-death tests do not prove
resilience to physical power loss or storage corruption. Exactly-once delivery and
exactly-once external side effects are not guaranteed; this is not a production
readiness claim.

Provider-specific and customer-backend integrations, business-specific recovery and
observability are potential professional services, not adapters included in this
release. See [architecture](architecture.md) and the [MIT license](../LICENSE).
