"""Controlled-response regressions; run with python -B -m unittest discover here."""
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import simulator
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import subprocess
import sys
from threading import Thread


class SimulatorVerificationTests(unittest.TestCase):
    def setUp(self):
        self.events = [{'eventId': 'e0', 'paymentId': 'p0'}, {'eventId': 'e1', 'paymentId': 'p1'}]
        self.processed = {'outcome': 'Processed', 'activationCreated': True}
        self.duplicate = {'outcome': 'Duplicate'}

    def result(self, index, response):
        event = self.events[index]
        return event['eventId'], event['paymentId'], response, 1

    def test_valid_outcomes_can_arrive_in_any_order(self):
        results = [self.result(1, self.duplicate), self.result(0, self.processed),
                   self.result(1, self.processed), self.result(0, self.duplicate)]
        totals, created = simulator.verify_outcomes(self.events, results)
        self.assertEqual(dict(totals), {'Processed': 2, 'Duplicate': 2})
        self.assertEqual(created, 2)

    def test_previous_aggregate_false_pass_is_rejected(self):
        results = [self.result(0, self.processed), self.result(1, self.duplicate),
                   self.result(0, self.processed), self.result(1, self.duplicate)]
        with self.assertRaisesRegex(RuntimeError, 'exactly one Processed'):
            simulator.verify_outcomes(self.events, results)

    def test_wrong_payment_identity_is_rejected(self):
        with self.assertRaises(RuntimeError):
            simulator.verify_outcomes(self.events, [('e0', 'p1', self.processed, 1)])

    def test_missing_event_is_rejected(self):
        with self.assertRaises(RuntimeError):
            simulator.verify_outcomes(self.events, [self.result(0, self.processed)])

    def test_missing_activation_is_rejected(self):
        results = [self.result(0, self.processed), self.result(1, {'outcome': 'Processed', 'activationCreated': False})]
        with self.assertRaisesRegex(RuntimeError, 'exactly one activation'):
            simulator.verify_outcomes(self.events, results)

    def test_duplicate_with_activation_flag_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'combination'):
            simulator.verify_outcomes(self.events, [self.result(0, {'outcome': 'Duplicate', 'activationCreated': True})])

    def test_unexpected_outcome_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'combination'):
            simulator.verify_outcomes(self.events, [self.result(0, {'outcome': 'UnsupportedEvent'})])

    def test_main_associates_responses_and_does_not_print_pass_for_false_pass_case(self):
        args = SimpleNamespace(events=2, deliveries=4, workers=1, run_id='controlled', database=None)
        def send(_args, body, _secret, invalid=False):
            if invalid:
                return {'outcome': 'InvalidSignature'}, 1
            event_id = json.loads(body)['eventId']
            return (self.processed if event_id.endswith('_0') else self.duplicate), 1
        output = StringIO()
        with patch.object(simulator, 'arguments', return_value=args), patch.object(simulator, 'send', side_effect=send), \
                patch.dict(os.environ, {'MOCK_WEBHOOK_SECRET': 'test-only-secret-at-least-32-bytes'}), redirect_stdout(output):
            with self.assertRaisesRegex(RuntimeError, 'exactly one Processed'):
                simulator.main()
        self.assertNotIn('Verification: PASS', output.getvalue())

    def test_false_pass_case_exits_nonzero_through_real_cli(self):
        secret = 'test-only-secret-at-least-32-bytes'
        class ControlledServer(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                correct = 'v1=' + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
                valid = self.headers['X-Mock-Signature'] == correct
                event_id = json.loads(body)['eventId']
                result = ({'outcome': 'Processed', 'activationCreated': True} if event_id.endswith('_0')
                          else {'outcome': 'Duplicate'}) if valid else {'outcome': 'InvalidSignature'}
                encoded = json.dumps(result).encode()
                self.send_response(200 if valid else 401)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
        server = HTTPServer(('127.0.0.1', 0), ControlledServer)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run([sys.executable, '-B', str(Path(simulator.__file__)),
                '--endpoint', 'http://127.0.0.1:' + str(server.server_port) + '/webhooks/mock-payment',
                '--events', '2', '--deliveries', '4', '--workers', '1'],
                env={**os.environ, 'MOCK_WEBHOOK_SECRET': secret}, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertIn('Verification: FAIL', result.stderr)
            self.assertNotIn('Verification: PASS', result.stdout)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
