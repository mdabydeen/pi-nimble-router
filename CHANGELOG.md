# Changelog

## Unreleased

- Add a dependency-free GitHub Actions verification job for the self-check, redacted debug output, package shape, and patch whitespace.

## 0.2.2 — 2026-10-03

- Honour a request that is already cancelled before invoking the local router; return the configured fallback immediately.
- Emit a redacted `NIMBLE_DEBUG` record on the cancel path (router ref and fallback target) without echoing a router response.
- Document the cancellation contract in the README alongside the other routing boundaries.
- Keep regression coverage for router failures and pre-cancelled requests in the repository self-check.

## 0.2.1 — 2026-10-03

- Redact the raw local-router response from `NIMBLE_DEBUG` output; retain only the router ref, response length, and parsed choice.
- Clarify the evaluation guidance so debug records do not echo copied task text.

## 0.2.0 — 2026-10-03

- Add `local`, `cloud`, and `heavy` routing tiers selected by a local Ollama model.
- Keep continuations and retries on the model already selected for the turn.
- Fall back to the configured local path when routing is unavailable or a remote provider is not authenticated.
- Treat pasted task text as untrusted router input and parse only the router's final verdict line.
- Prevent project-local settings from choosing remote targets or cloud-routing hints.
- Clarify in the README that a remotely routed turn is sent to the provider configured and authenticated by the user.

This release documents the routing contract and configuration boundaries. It does not claim benchmarks, adoption, safety certification, or revenue.
