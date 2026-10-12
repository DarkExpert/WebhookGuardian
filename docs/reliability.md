# WG-002 reliability verification

Webhook Guardian Community v0.1.0 demonstrates authenticated ingestion and
transactional local idempotency. WG-002 adds verification and a standard-library
Python sender. Production source, signing protocol and HTTP outcomes are unchanged.

## Run the checks

Requires the documented Node.js 24 runtime and installed npm dependencies:

```text
npm run build
npm run typecheck
npm test
npm audit
npm run demo
python -B -m unittest discover -s examples/python-simulator -v
```

The baseline contains 44 tests. WG-002 adds six integration cases: three concurrent
delivery cases, one writer-lock case, and two crash/restart cases. Remediation adds
three failure-classification/retry cases and five compilation/teardown regressions
(58 Node tests total), plus nine standard-library Python verification tests.
The Python tests include the original false-pass distribution and a real CLI run
against controlled responses that must exit 1. Tests compile the
current production source into isolated ignored directories under `node_modules`;
they do not depend on a stale `dist` build. Each case creates its own local temporary
database and cleans up only its own child processes and files. Compilation failures
remove their partial build directory and preserve the original exception. Teardown
has a finite 5-second deadline, forces only its own children, and confirms child
closure before removing database files. Cleanup failures are reported separately
when a primary test failure already exists. Unclosed child resources are retained
for inspection rather than deleting a database that may still be in use. No Python
executable is required for the Node suite; run Python verification separately.

## Process architecture and concurrency

`test/helpers/reliability-worker.mjs` starts the real `buildApp` in separate Node
processes, bound to OS-assigned loopback ports. Readiness messages include the bound
address and PID. Tests start database connections sequentially, then deliver signed
HTTP requests concurrently across both processes. Each process has its own event
loop and SQLite connection. This is distinct from the older same-event-loop inject
test and avoids reserving/releasing guessed HTTP ports.

The cases inspect actual reopened SQLite rows, completion states, activation flags
and the correspondence between event IDs and payment IDs:

| Deliveries | Events | Payments | Required persisted result |
| --- | --- | --- | --- |
| 20 identical deliveries | 1 | 1 | 1 completed event, 1 activation; 1 Processed, 19 Duplicate |
| 20 distinct event IDs | 20 | 1 | 20 completed events, 1 activation; only one activationCreated flag |
| 100 deliveries across two processes | 10 | 10 | 10 completed events, 10 activations; 10 Processed, 90 Duplicate |

These are assertions for bounded test workloads, not throughput promises or a
stress benchmark. A generic `503 ProcessingFailed` alone does not establish lock
contention: the public API deliberately conceals all internal failure causes.
Only the test worker wraps Inbox processing and sends sanitized, per-request
diagnostics over its private stdout channel. A test-only request ID correlates each
503 with its own diagnostic; primary SQLite code 5 (BUSY) or 6 (LOCKED), including
extended variants, is required before the test sender retries. Unknown/internal
failures or missing diagnostics fail the test, even if redelivery would succeed.
The sender permits at most three attempts and reports sanitized retry exhaustion.
Production request handling and responses are unchanged. The application never retries.

## Transactions and held locks

`BEGIN IMMEDIATE` acquires writer access before event identity is checked. Inbox
insertion, the local activation and the completion record share that transaction.
`COMMIT` must succeed before `Processed` can be returned. The event primary key
deduplicates delivery identity; the independent payment primary key prevents
different event IDs from repeating a payment activation. JSON formatting changes
do not change identity, while changed validated field values return `EventConflict`.

SQLite serializes writers sharing one file. The configured busy timeout is 5 seconds.
WAL permits readers while a writer holds an uncommitted transaction. A synchronous
lock wait blocks that server's Node event loop; this remains an accepted MVP limit.

The lock test starts an independent SQLite process, waits for its explicit `locked`
signal, and then sends a signed webhook. It requires 503 and no committed inbox or
activation rows. The parent commands release, waits for `released`, redelivers, and
requires one completed event and one activation. No sleep guesses lock readiness
or release. The busy timeout itself is intentionally exercised, and its diagnostic
must confirm a real SQLite lock error. Separate test-only IPC injection exercises
unknown failures, synthetic BUSY retry exhaustion, and an extended LOCKED code;
those injected cases test classification and limits, not actual lock acquisition.

The wrappers and IPC injection commands are defined only in the test worker. No
HTTP request can enable a fault, and none of this instrumentation is built into
the shipped server.

## Crash checkpoints and recovery

Only the test worker intercepts `DatabaseSync.exec` around the **actual production
Inbox transaction**. It checks local event and activation rows, writes a synchronous
checkpoint signal to stdout, and parks in `Atomics.wait`. The parent waits for that
signal and uses `child.kill('SIGKILL')` on that particular child, then waits for exit.
Windows forcibly terminates the child; POSIX sends SIGKILL. No process scanning,
unrelated PID termination, HTTP injection endpoint or shipped environment switch is
used. The harness lives outside `src` and is excluded from the production build.

| Checkpoint | State in paused worker | Expected reopened database | Restart/redelivery |
| --- | --- | --- | --- |
| Before COMMIT | Activation exists and inbox is completed inside an active, uncommitted transaction | Neither row survives | Processed, activationCreated true; one event and activation |
| After confirmed COMMIT | COMMIT has returned and transaction is inactive; both rows exist | Both rows survive | Duplicate; original activation remains unchanged |

The before-COMMIT checkpoint is deliberately late: even the completion UPDATE has
run, so the test proves that neither a business mutation nor a tentative completed
state survives an uncommitted process termination. The after-COMMIT worker is killed
before `Inbox.process` returns, demonstrating recovery when an acknowledgement can
be lost. Assertions use database state rather than an HTTP response as evidence of
commit. Redelivery occurs through a newly started HTTP server with HMAC validation.

This harness tests real SQLite persistence and process death while reusing the
production transaction code. It does not interrupt a live Fastify handler at these
checkpoints, simulate a host crash, power loss, disk-full condition or faulty storage.

Local verification on 2026-10-12 used Windows, Node.js 24.19.0 and bundled SQLite
3.53.3. All six reliability cases passed: the held lock returned 503 with no rows;
before-COMMIT termination reopened with neither row and then processed on redelivery;
after-COMMIT termination reopened with both rows and returned Duplicate on redelivery.
The original suite passed 50 tests across four files; after focused remediation,
58 Node tests across five files and nine Python regressions passed on Windows and
Ubuntu 24.04 (WSL). Ubuntu used an isolated, checksum-verified Node.js 24.19.0 runtime
and Python 3.12.3; build, typecheck and audit also passed. This verifies Linux process
behavior in WSL, not a hosted GitHub Actions run. No power-loss result is claimed.

## Python simulator

Requires Python 3.9+; no external packages. Start Guardian normally, set
`MOCK_WEBHOOK_SECRET` in the simulator terminal to the same development secret, and
run from the repository directory. Python does not read `.env` automatically.

```text
python examples/python-simulator/simulator.py --database ./guardian.sqlite
python examples/python-simulator/simulator.py --endpoint http://127.0.0.1:3000/webhooks/mock-payment --events 10 --deliveries 100 --workers 8
```

The script constructs immutable version-1 JSON bytes, signs those exact bytes with
HMAC-SHA256 and sends them unchanged. A thread pool distributes repeated deliveries.
One additional request flips a digest digit and must receive InvalidSignature.
Secrets are read only from the environment and never printed. Requests default to
localhost, use a 15-second timeout, disable environment proxies and redirects, and
retry only explicit `503 ProcessingFailed` responses with bounded sender backoff.
Transport failures and unexpected outcomes fail the demo instead of being hidden.
Unlike the instrumented test worker, an ordinary Python sender cannot identify the
internal cause of a generic 503. Its retry policy applies to that public outcome,
not a claim that SQLITE_BUSY occurred.

Every run creates fresh UUID-based event/payment IDs and computes actual totals.
`--run-id` is available for reproducibility, but must be fresh: reuse can conflict
with stored content or fail the expected first-activation checks. `--events` controls
unique events/payments; `--deliveries` must be at least that number. `--workers`,
`--timeout` and `--retries` are configurable. See `--help` for bounds.

Each response retains its submitted event and payment IDs. For a fresh run, API
verification requires exactly one Processed response per event and exactly one
activationCreated=true response per payment; other deliveries must be Duplicate
with no activation flag. Unknown identities, multiple activations, missing events,
and unexpected response-field combinations fail even if aggregate totals match.
Database verification remains an additional independent check of persisted state.

The summary distinguishes logical valid deliveries from total HTTP attempts
(including invalid-signature traffic and retries). Without `--database`, business
activation counts are API-reported and verification explicitly says API-only.
With `--database`, Python opens that file read-only and checks the run's event
identities, content, completed states, activation flags and payment/event pairs.
Unrelated existing rows are excluded from totals. A missing/mismatched database,
unexpected response, or wrong totals exits nonzero. Verification must use the same
local file as Guardian; a database on a remote server cannot be verified this way.

The local Python 3.12.14 demonstration returned 100 valid deliveries, 10 Processed,
90 Duplicate, 10 activations verified in SQLite, and one rejected invalid signature
(101 HTTP attempts). An API-only run returned 12 deliveries, 3 Processed and 9
Duplicate. Wrong-secret and missing-database checks each exited 1. These are observed
verification results, not fixed output values or guaranteed future throughput.

## Guarantees and limits

The tested guarantee is local SQLite idempotency while its records are retained.
WAL and synchronous FULL assume a suitable local filesystem with working locks and
sync operations. Network shares are unsupported. Retain the live WAL alongside the
database when handling files; copying only a live database is not a safe backup.

Neither exactly-once delivery nor exactly-once external side effects are guaranteed.
The service calls no external APIs and processes no real payments. Storage errors,
lost acknowledgements and contention may require sender retries. No application
retry loop, queue, recovery worker, monitoring service or provider adapter was added.
Real integrations, advanced recovery, monitoring and cloud deployment remain outside
the Community implementation. Public demo and CI preparation add no provider or
backend integrations. See [architecture](architecture.md) and the
[draft release notes](release-notes-v0.1.0.md).

## Isolated public demo

`npm run demo` builds the source and runs [run-demo.mjs](../scripts/run-demo.mjs).
The runner creates a new OS temporary directory and SQLite file, generates a random
development-only secret, and starts the unchanged Fastify app in an owned child
through [demo-server.mjs](../scripts/demo-server.mjs). It binds loopback port 0 and
reports the assigned address over IPC after listening; no fixed sleep or guessed
port is used. The normal executable's PORT validation remains unchanged.

The existing Python simulator receives this temporary endpoint/database and performs
100 deliveries for 10 events, checking outcomes per identity and persisted rows,
plus one invalid signature. After the server exits, the runner independently reopens
SQLite and asserts 10 completed inbox rows and 10 corresponding activations.
Only then are temporary files removed and the PASS summary printed. It ignores the
user's DATABASE_PATH and .env and does not access an existing application database.

Startup has a 15-second deadline, Python discovery 3 seconds per candidate, simulator
execution 60 seconds, each HTTP request 10 seconds, and owned-child/file cleanup
5 seconds. A child that does not close gracefully is forcibly terminated; failures
remain nonzero even if cleanup later succeeds. If child closure cannot be confirmed,
files are retained and the runner reports cleanup failure rather than deleting an
in-use database. Only stored child handles are signaled; there is no process scanning
or unrelated PID termination. Set PYTHON to an executable path when discovery cannot
find Python 3.9+; no user-installed Python packages are needed.

The [GitHub Actions workflow](../.github/workflows/ci.yml) runs the complete Node and
Python checks and this demo on Ubuntu 24.04, with read-only token permissions and
official SHA-pinned actions. No user secrets, database uploads or log artifacts are
used. A successful local/WSL run is not evidence that hosted Actions has executed.

Fresh WG-003 verification on 2026-10-12 passed npm ci, build, typecheck, all 58 Node
tests and nine Python regressions on Windows and Ubuntu 24.04 WSL. Both npm run demo
runs produced 100 deliveries, 10 Processed, 90 Duplicate, 10 SQLite-verified
activations and one invalid-signature rejection, with the parent confirming 10
completed inbox rows and 10 activation rows after shutdown. Missing-Python failure
checks exited 1 and removed their temporary directories. Ubuntu also exercised a
simulator-child exit failure with successful cleanup. No owned demo/reliability
workers remained after the success and failure checks. Audit reported zero
vulnerabilities; the hosted Actions workflow has not yet run for these changes.
