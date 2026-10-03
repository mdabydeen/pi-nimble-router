# pi-nimble-router

A local-first model router for [Pi](https://github.com/earendil-works/pi). Register one virtual
model, `nimble/auto`, and Pi routes each turn between a **heavy local model** (ollama) and a
**logged-in cloud model** (OpenAI, Anthropic, ...) — with the routing *decision* made by a fast
local model on ollama. No external gateway, no per-request upload of your text.

The idea mirrors the `jev-router` pattern (a virtual model that picks a physical model per request),
but replaces the paid Vercel/TypeSafe Jev call with a cheap ollama call, so routing is private and
free.

## Install

```sh
# from a clone
pi install ./

# or load for one invocation while developing
pi --extension ./index.ts --model nimble/auto
```

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
        "cloud": "openai/gpt-5",
        "default": "local",
        "timeoutMs": 15000,
        "cloudWhen": "architecture, hard debugging, cross-cutting design, research"
    }
}
```

| field | meaning | default |
|---|---|---|
| `router` | fast local model that decides | the default model |
| `local` | heavy local model to route to | the default model |
| `cloud` | logged-in cloud model to route to | _(unset — routes stay local)_ |
| `default` | where to send a turn when there is no decision | `local` |
| `timeoutMs` | router decision budget | `15000` |
| `cloudWhen` | natural-language hint for when to prefer cloud | none |
| `routerMaxTokens` | max output tokens for the router call | `32` |
| `routerOptions` | sampling params for the router call | `{ reasoning_effort: "none", temperature: 0 }` |

`router`/`local`/`cloud` are `provider/id`. The router and local targets just need their provider
configured (ollama always is). The cloud target is only used when that provider is **logged in**;
otherwise every turn stays local. `default` must be a real model.

## How it decides

- **New user turn** (`reason === "user"`): the router model is asked, in one short local call, to
  answer `local` or `cloud`. The **last** mention wins (a thinking model narrates first, its verdict
  lands last); an unparseable or empty reply falls through to `default`.
- **Within a turn** (`continuation`, `retry`): the model from the last successful/failed response is
  kept, so prompt caches and thinking signatures stay valid.
- **Off the agent loop** (`direct`, e.g. compaction summaries): goes straight to the local target;
  the router is not called.
- **Failures are soft**: router unavailable, timed out, or unparseable → `default`. If `cloud`
  isn't configured or logged in → `local`.

## Thinking routers

If your `router` model reasons (a "thinking" model), it can spend its whole output on a preamble and
leave the verdict out of the response's `content`. The defaults handle this two ways:
`reasoning_effort: "none"` asks ollama to skip the preamble (the verdict then arrives in `content`
in ~0.1s), and `temperature: 0` makes the one-word choice deterministic. Non-thinking models ignore
the suppression key. To run a router the opposite way, set `"routerOptions": {}`. Debug any decision
with `NIMBLE_DEBUG=1 pi ...` (it logs the raw router answer and the parsed choice to stderr).

## Security

- **Prompt injection of the router.** Routing is decided by a local model, whose prompt
  contains your (possibly pasted, untrusted) text. The router input is therefore wrapped
  in explicit `UNTRUSTED DATA` markers and the parser only reads the router's own final
  line, so a `cloud`/`local` token embedded in pasted content can no longer force a route.
  This bounds but cannot fully defeat injection; the verdict still must come from outside
  the delimited region.
- **Exfil targets come from trusted config only.** `cloud`/`cloudWhen` may be set in the
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
node selfcheck.ts
```

MIT.
