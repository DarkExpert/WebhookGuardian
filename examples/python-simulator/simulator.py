#!/usr/bin/env python3
"""Local mock webhook reliability demo using only the Python standard library."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', default='http://127.0.0.1:3000/webhooks/mock-payment')
    parser.add_argument('--events', type=int, default=10, help='Unique event and payment IDs')
    parser.add_argument('--deliveries', type=int, default=100, help='Valid logical deliveries')
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--timeout', type=float, default=15, help='HTTP timeout in seconds')
    parser.add_argument('--retries', type=int, default=2, help='Sender retries of explicit 503 responses')
    parser.add_argument('--database', type=Path, help='Optional local Guardian database for read-only verification')
    parser.add_argument('--run-id', default=uuid.uuid4().hex, help='Fresh namespace; do not reuse a previous run')
    args = parser.parse_args()
    if not 1 <= args.events <= 1000 or not args.events <= args.deliveries <= 10000:
        parser.error('Require 1 <= events <= 1000 and events <= deliveries <= 10000')
    if not 1 <= args.workers <= 64 or not 0 < args.timeout <= 120 or not 0 <= args.retries <= 5:
        parser.error('Require workers 1..64, timeout (0,120], retries 0..5')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.run_id):
        parser.error('run-id must contain 1..64 ASCII letters, digits, underscores or hyphens')
    endpoint = urllib.parse.urlsplit(args.endpoint)
    if endpoint.scheme not in ('http', 'https') or not endpoint.hostname or endpoint.username or endpoint.password:
        parser.error('endpoint must be an HTTP(S) URL without credentials')
    return args


def send(args, body, secret, invalid=False):
    digest = hmac.new(secret, body, hashlib.sha256).hexdigest()
    if invalid:
        digest = ('0' if digest[0] != '0' else '1') + digest[1:]
    for attempt in range(args.retries + 1):
        request = urllib.request.Request(args.endpoint, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'X-Mock-Signature': 'v1=' + digest,
        })
        # Disable environment proxies and redirects: never forward a signed demo to another endpoint.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            response = opener.open(request, timeout=args.timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError):
            raise RuntimeError('HTTP transport failed or timed out') from None
        with response:
            status = response.code
            try:
                result = json.loads(response.read(4097))
            except (ValueError, UnicodeError):
                raise RuntimeError('Server returned invalid JSON') from None
        if not isinstance(result, dict):
            raise RuntimeError('Server returned an unexpected JSON response')
        if not invalid and status == 503 and result.get('outcome') == 'ProcessingFailed' and attempt < args.retries:
            time.sleep(min(0.1 * 2 ** attempt, 1.0))
            continue
        expected = (status == 401 and result.get('outcome') == 'InvalidSignature') if invalid else (
            status == 200 and result.get('outcome') in ('Processed', 'Duplicate'))
        if not expected:
            raise RuntimeError('Server returned an unexpected HTTP status/outcome')
        if not invalid and result['outcome'] == 'Processed' and type(result.get('activationCreated')) is not bool:
            raise RuntimeError('Processed response has no boolean activationCreated')
        return result, attempt + 1
    raise RuntimeError('Sender retries exhausted')


def verify_database(path, events):
    # URI mode=ro prevents creation or mutation of the application database.
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        stored_events = []
        activations = []
        for start in range(0, len(events), 250):
            batch = events[start:start + 250]
            placeholders = ','.join('?' for _ in batch)
            stored_events.extend(connection.execute(
                'SELECT event_id, content, state, activation_created FROM inbox WHERE event_id IN (' + placeholders + ')',
                [event['eventId'] for event in batch]).fetchall())
            activations.extend(connection.execute(
                'SELECT payment_id, event_id FROM payment_activations WHERE payment_id IN (' + placeholders + ')',
                [event['paymentId'] for event in batch]).fetchall())
        expected_events = {event['eventId']: event for event in events}
        expected_activations = {(event['paymentId'], event['eventId']) for event in events}
        if len(stored_events) != len(events) or set(activations) != expected_activations or len(activations) != len(events):
            raise RuntimeError('Persisted event/activation counts or identities do not match')
        for event_id, content, state, created in stored_events:
            if state != 'completed' or created != 1 or json.loads(content) != expected_events[event_id]:
                raise RuntimeError('Persisted event content or completion state does not match')
        return len(activations)
    finally:
        connection.close()


def verify_outcomes(events, results):
    """Verify responses against the submitted identities, not just aggregate totals."""
    expected = {event['eventId']: event['paymentId'] for event in events}
    processed = Counter()
    activations = Counter()
    delivered = Counter()
    totals = Counter()
    for event_id, payment_id, result, _attempts in results:
        if event_id not in expected or expected[event_id] != payment_id:
            raise RuntimeError('Response is associated with an unexpected submitted identity')
        outcome = result.get('outcome')
        if outcome == 'Processed' and set(result) == {'outcome', 'activationCreated'} and type(result['activationCreated']) is bool:
            processed[event_id] += 1
            activations[payment_id] += int(result['activationCreated'])
        elif outcome != 'Duplicate' or set(result) != {'outcome'}:
            raise RuntimeError('Unexpected response combination')
        delivered[event_id] += 1
        totals[outcome] += 1
    if set(delivered) != set(expected) or any(processed[event_id] != 1 for event_id in expected):
        raise RuntimeError('Each fresh event must have exactly one Processed response')
    if any(activations[payment_id] != 1 for payment_id in set(expected.values())):
        raise RuntimeError('Each fresh payment must have exactly one activation')
    return totals, sum(activations.values())


def main():
    args = arguments()
    secret_text = os.environ.get('MOCK_WEBHOOK_SECRET', '')
    secret = secret_text.encode('utf-8')
    if len(secret) < 32 or not secret_text.strip():
        raise RuntimeError('Configure MOCK_WEBHOOK_SECRET with at least 32 UTF-8 bytes, not whitespace-only')
    occurred_at = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    events = [{
        'schemaVersion': '1', 'eventId': 'demo_' + args.run_id + '_' + str(i),
        'eventType': 'payment.completed', 'occurredAt': occurred_at,
        'paymentId': 'payment_' + args.run_id + '_' + str(i),
    } for i in range(args.events)]
    bodies = [json.dumps(event, separators=(',', ':'), ensure_ascii=True).encode('utf-8') for event in events]
    def delivery(i):
        index = i % args.events
        result, attempts = send(args, bodies[index], secret)
        return events[index]['eventId'], events[index]['paymentId'], result, attempts
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(delivery, range(args.deliveries)))
    invalid_result, invalid_attempts = send(args, bodies[0], secret, invalid=True)
    totals, created = verify_outcomes(events, results)
    stored = verify_database(args.database, events) if args.database else None
    print('Webhook Guardian - Reliability Demo')
    print('Deliveries: ' + str(len(results)))
    print('Unique Event IDs: ' + str(len({events[i % len(events)]['eventId'] for i in range(len(results))})))
    print('Processed Events: ' + str(totals['Processed']))
    print('Duplicate Deliveries: ' + str(totals['Duplicate']))
    print('Business Activations: ' + str(created if stored is None else stored))
    print('Rejected Invalid Signatures: ' + str(int(invalid_result['outcome'] == 'InvalidSignature')))
    print('HTTP Attempts: ' + str(sum(attempts for _, _, _, attempts in results) + invalid_attempts))
    print('State Verification: ' + ('SQLite verified (this run only)' if stored is not None else 'API only; database not inspected'))
    print('Verification: PASS')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, sqlite3.Error, OSError, ValueError):
        # Deliberately avoid arbitrary exception strings, URLs, paths or configuration values.
        print('Verification: FAIL - check configuration, endpoint, fresh run-id and persisted state', file=sys.stderr)
        sys.exit(1)
