# Changelog

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
