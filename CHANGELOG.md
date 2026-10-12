# Changelog

## [Unreleased] — Community v0.1.0 release preparation

### Added

- Version-1 mock payment webhook endpoint with raw-body HMAC-SHA256 authentication.
- Strict event validation and sanitized machine-readable HTTP outcomes.
- Persistent SQLite inbox, event-content conflict detection and unique mock payment activations.
- Atomic inbox completion and local business mutation with rollback on failure.
- Separate-process delivery tests, held-writer-lock checks and controlled crash/restart verification.
- Python standard-library simulator with per-event verification and optional read-only SQLite checks.
- Isolated one-command demo with generated development credentials and bounded child cleanup.
- SHA-pinned GitHub Actions workflow for Ubuntu 24.04, Node.js 24 and Python 3.12.
- Architecture, reliability and draft release documentation.

This version has not been tagged or published. Real provider adapters, external
business effects, production deployment and exactly-once delivery are outside scope.
