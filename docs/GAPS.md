# Gaps / Roadmap

Open work, deliberately not built yet. Each is a conscious deferral, not an
oversight. Revisit when the trigger condition in parentheses arrives.

## Not built — with a reason to skip for now

- **Integration test against a real Ollama / remote provider.** The registry is
  mocked in `selfcheck.ts` on purpose: the pure logic is fully covered, and a real
  provider call is non-deterministic and costs money. *(Trigger: a provider-
  specific bug, or a change to `index.ts`'s dispatch that logic tests can't reach.)*
- **Decision-latency / perf harness & benchmark.** The README disclaims cost,
  latency, and quality claims. A router call is cut at `timeoutMs` and proven, but
  there is no measurement of real-world latency. *(Trigger: a user reports a
  decision is slow, or a real perf claim is intended.)*
- **Runtime telemetry / route-outcome metrics.** Nothing logs *which tier won or how
  often fallback fired* across a session. *(Trigger: users start adopting it and
  observability is the bottleneck; add it behind a flag, never on by default.)*
- **Lint / typecheck.** "Whitespace + node strips types" is not a linter or a
  typecheck; a wrong `RouterRegistry` shape or import can pass CI. *(Trigger: a
  CI-failing-in-prod-but-green-here incident, or a second contributor joins.)*
- **Adversarial fuzzing of `parseDecision`.** It's tested with hand-picked inputs,
  not swept. *(Trigger: a real injection slip through, or before a security claim.)*
- **Release automation / semantic-versioning + changelog enforcement.** Version
  bumps and the CHANGELOG are manual. *(Trigger: more than one release per week.)*
- **Multi-version CI matrix across `pi-ai` / `pi-coding-agent`.** Peer deps are
  unpinned (`*`); no compatibility range is exercised. *(Trigger: a downstream break.)*

### Smart compaction (the `session_before_compact` bridge)

- **No integration test for the compaction bridge.** `compaction.ts` (the decision
  logic: `parseKeep`/`prunePlan`/`buildKeepPrompt`/`resolveFloor`) *is* unit-tested, incl.
  an offline eval, but the `session_before_compact` handler in `index.ts` is Pi-bound and
  unrunnable here — same status as *sticky-within-a-turn*. *(Trigger: a compaction bug in
  the live path, matching the existing "integration test" deferral.)*
- **One call, not two.** v1 asks the router once for a single keep-count and trusts it
  (with a hard floor), instead of the Jev skill-suggestion *two-call* pattern (rank-then-
  re-check the top). Compaction is rare and cut-bounded, so one call is enough for v1.
  *(Trigger: a fold proves to have dropped a load-bearing turn the router over-ranked.)*
- **The summarizer is the configured `local` tier.** nimble decides the *cut*; `cfg.local`
  writes the *summary*. When `local` is weak (a 3B model), summaries can lose detail — a known
  quality risk, not a correctness one. A stronger "nimble does the whole fold" mode is a later
  opt-in. *(Trigger: a weak-local user reports lossy summaries.)*
- **Prefix cut only.** The router decides *how far back* to fold, not *which* older
  elements to keep individually; true sparse per-message retention is still blocked by
  `CompactionResult.firstKeptEntryId` being a contiguous cut. *(Trigger: a per-element
  `CompactionResult`/`prune` API from Pi, like a Jev `prune()` call.)*

## Documentation staleness to close when it recurs

- The README and `evaluation-checklist.md` pin `v0.2.2` as the reviewed install
  ref while `package.json` is `0.2.3` (a doc-only release). Re-pin to the next
  reviewed release when one ships. This is a *reviewed-release pin*, not code drift.
- No per-feature `docs/features/<name>.md` spec. Add one only for a non-trivial
  change (a new tier, a new exfil field), not per edit.

## Enforced, not optional

The contract guards below are in `selfcheck.ts` (run by CI via `npm test`):
`EXFIL_KEYS` is locked to the known set, and a router that ignores `timeoutMs` is
proven to fail soft. Do not remove these without a reason recorded here.
