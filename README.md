# pi-nimble-router

A local-first model router for [Pi](https://github.com/earendil-works/pi). Register one virtual
model, `nimble/auto`, and Pi routes each turn between a fast local model, an optional remote model,
and an optional stronger remote model. The routing decision is made by a local model through
Ollama. There is no third-party routing gateway. When a turn is routed remotely, Pi sends it to the
provider you configured and authenticated.

The idea mirrors the `jev-router` pattern (a virtual model that picks a physical model per request),
but replaces the paid Vercel/TypeSafe Jev call with a local Ollama call. That keeps the routing
decision local and avoids adding another service to the request path.

## Install

```sh
# install the pinned public GitHub release
pi install git:github.com/mdabydeen/pi-nimble-router@v0.2.2

# or, from a clone
pi install ./

# or load for one invocation while developing
pi --extension ./index.ts --model nimble/auto
```

Pi's package manager supports pinned Git refs, so the GitHub command keeps the install on the
reviewed `v0.2.2` release. An npm install command will be added only after the package is actually
published to npm.

## Use

```sh
pi --model nimble/auto
```

Start and type `/model nimble/auto`. The footer shows which physical model each response used,
e.g. `nimble/auto • low → ollama/qwen3.8:27b-mlx` or `... → openai/gpt-5`.

## Configure

Merge `nimbleRouter` into `~/.pi/agent/settings.json` (or `<cwd>/.pi/settings.json`, which overrides
non-exfil fields), then `/reload`.

```json
{
    "nimbleRouter": {
        "router": "ollama/llama3.2:3b",
        "local": "ollama/qwen3.8:27b-mlx",
        "cloud": "anthropic/claude-sonnet-4-6",
        "heavy": "anthropic/claude-opus-5-5",
        "default": "local",
        "timeoutMs": 15000,
        "cloudWhen": "architecture, hard debugging, cross-cutting design, research"
    }
}
```

| field | meaning | default |
|---|---|---|
| `router` | fast local model that decides | the default model |
| `local` | light/quick default tier to route to | the default model |
| `cloud` | cheaper logged-in remote model (work a local can't do, but not very hard) | _(unset — routes stay local)_ |
| `heavy` | strongest logged-in remote model, only for the hardest work | _(unset)_ |
| `default` | where to send a turn when there is no decision | `local` |
| `timeoutMs` | router decision budget | `15000` |
| `cloudWhen` | natural-language hint for when to prefer cloud | none |
| `routerMaxTokens` | max output tokens for the router call | `32` |
| `routerOptions` | sampling params for the router call | `{ reasoning_effort: "none", temperature: 0 }` |

`router`/`local`/`cloud`/`heavy` are `provider/id`. The router and local targets just need their provider
configured (ollama always is). The remote targets are only used when that provider is **logged in**;
otherwise every turn stays local. A `heavy` verdict downgrades to `cloud`, then `local`, if that model
isn't logged in. `default` must be a real model.

## How it decides

- **New user turn** (`reason === "user"`): the router model is asked, in one short local call, to
  answer `local`, `cloud`, or `heavy`. The **last** mention wins (a thinking model narrates first, its verdict
  lands last); an unparseable or empty reply falls through to `default`.
- **Within a turn** (`continuation`, `retry`): the model from the last successful/failed response is
  kept, so prompt caches and thinking signatures stay valid.
- **Off the agent loop** (`direct`, e.g. compaction summaries): goes straight to the local target;
  the router is not called.
- **Failures are soft**: router unavailable, timed out, or unparseable → `default`. A remote
  target that isn't configured or logged in (or a `heavy` requested but not available) downgrades
  to `cloud`, then `local`.
- **Cancellation is soft**: if a request is already cancelled, the router call is skipped and the
  configured `default` is returned. If cancellation arrives while the router is running, the call
  is aborted and follows the same fallback path. With `NIMBLE_DEBUG=1`, the cancel record contains
  only the router reference, cancellation marker, and fallback target; it does not echo task text
  or the router response.

## Thinking routers

If your `router` model reasons (a "thinking" model), it can spend its whole output on a preamble and
leave the verdict out of the response's `content`. The defaults handle this two ways:
`reasoning_effort: "none"` asks ollama to skip the preamble (the verdict then arrives in `content`
in ~0.1s), and `temperature: 0` makes the one-word choice deterministic. Non-thinking models ignore
the suppression key. To run a router the opposite way, set `"routerOptions": {}`. Debug any decision
with `NIMBLE_DEBUG=1 pi ...` (it logs the router ref, response length, and parsed choice to stderr; it intentionally does not echo the raw response).

## Security

- **Prompt injection of the router.** Routing is decided by a local model, whose prompt
  contains your (possibly pasted, untrusted) text. The router input is therefore wrapped
  in explicit `UNTRUSTED DATA` markers and the parser only reads the router's own final
  line, so a `cloud`/`local` token embedded in pasted content can no longer force a route.
  This bounds but cannot fully defeat injection; the verdict still must come from outside
  the delimited region.
- **Exfil targets come from trusted config only.** `cloud`/`heavy`/`cloudWhen` may be set in the
  global/user settings, never in a project-local `<cwd>/.pi/settings.json`, so a cloned repo
  cannot quietly point routing at a cloud provider you have logged into. A project file may
  still tune the non-exfil fields.
- **Fail-closed on uncertainty.** A timed-out, unavailable, or unparseable router call
  routes to your `default` (local by default); a cloud that is unset or not logged in is
  ignored, so an unexpected turn never surprises its way to the cloud.

## Files

| file | role |
|---|---|
| `index.ts` | Pi extension; registers `nimble/auto`, reads config, dispatches. |
| `router.ts` | Pure routing logic (no Pi imports) — the decision contract, fully testable. |
| `selfcheck.ts` | `node selfcheck.ts` — runnable assertions for the pure logic. |

## Development

```sh
# routing logic self-check (Node strips TS types; no deps)
npm test
# or, directly
node selfcheck.ts
```

Every push and pull request runs the same self-check, a redacted-debug scan, a package dry-run,
and a whitespace check in GitHub Actions. These checks verify the repository contract; they are not
a benchmark or a production-readiness claim.

If the documented install or fallback behaviour does not match a test environment, use the
[installation feedback template](https://github.com/mdabydeen/pi-nimble-router/issues/new?template=installation-feedback.md)
with a sanitized, reproducible example. The [evaluation checklist](docs/evaluation-checklist.md)
organises a local-only baseline and fallback checks before you add an authenticated remote tier.
Do not include credentials, private prompts, or private file paths.

MIT.
