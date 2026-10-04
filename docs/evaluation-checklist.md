# Evaluation checklist

Use this checklist to inspect the router in a test Pi environment. It is a way to collect comparable observations, not a benchmark or a production-readiness claim.

## Before you start

- Use a disposable or non-production Pi project.
- Confirm that Ollama is running and the configured `router` and `local` models are available.
- Start with no remote target configured. Add an authenticated remote target only after the local path is understood.
- Do not place API keys, private prompts, customer data, or private file paths in notes or issue reports.

## 1. Establish the local baseline

1. Install the pinned release:

   ```sh
   pi install git:github.com/mdabydeen/pi-nimble-router@v0.2.0
   ```

2. Configure `nimble/auto` with `local` and `default` pointing to the same available local model.
3. Run one short task and record:
   - the task category;
   - the model shown in the footer;
   - whether the response completed; and
   - any relevant error text.

## 2. Add one remote tier

1. Add one authenticated `cloud` target while leaving `heavy` unset.
2. Repeat a similar task and record the same fields.
3. Use `NIMBLE_DEBUG=1` when you need to inspect the router's raw response and parsed verdict. Remove any sensitive text before sharing the output.

The result is an observation about one configuration. It is not evidence of cost savings, latency improvement, or general model quality.

## 3. Inspect fallback behaviour

Check one case at a time:

- router unavailable or timed out → the configured `default` is used;
- an unparseable router response → the configured `default` is used;
- `heavy` selected without an available heavy provider → downgrade to `cloud`, then `local`;
- `cloud` unavailable or unauthenticated → downgrade to `local`; and
- a continuation or retry → the model selected for the turn remains sticky.

Record the configured targets and the observed route. Do not record credentials.

## 4. Report a reproducible observation

Use the [installation-feedback template](https://github.com/mdabydeen/pi-nimble-router/issues/new?template=installation-feedback.md) if the documented behaviour does not match your test. Include only the Pi version, operating system and architecture, Ollama version, router model, install ref, expected behaviour, observed behaviour, and sanitized evidence.
