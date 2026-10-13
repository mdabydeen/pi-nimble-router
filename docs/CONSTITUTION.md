# Constitution

The invariants the router must respect. Every decision, feature, and fix is
evaluated against these. They are the cheap slice of spec-driven development —
"unit tests for the requirements" the code never gets to fail its way out of.

1. **Local decision, remote only by trusted config.** The routing decision is made
   by the configured local Ollama model. Task text leaves the machine *only* when
   the selected `cloud`/`heavy` target is remote **and** that provider is logged in.

2. **Fail closed.** An unavailable, timed-out, or unparseable router call routes to
   the configured `default` (local by default). Uncertainty never surprises a turn to
   the cloud.

3. **Exfil is config-scoped.** `router`, `cloud`, `heavy`, `cloudWhen` (the
   `EXFIL_KEYS` set) may be set only in trusted global/user settings, never in a
   project-local `<cwd>/.pi/settings.json`. A cloned repo may tune non-exfil fields
   but can never point routing at the user's logged-in cloud — or redirect the
   router, whose call transmits verbatim task text unauthenticated.

4. **Sticky within a turn.** Continuations and retries keep the model that handled
   the turn, so prompt caches and thinking signatures stay valid. Off-loop requests
   (`direct`, e.g. compaction) skip the router and go to local.

5. **The verdict is the router's own final line.** The router's input is untrusted
   data wrapped in `UNTRUSTED DATA` / `<<< TASK BEGIN … TASK END >>>` markers, and
   only the router's final non-empty line is parsed — so a routing token embedded in
   pasted content cannot steer the route. This bounds but does not defeat injection.

6. **Debug never exfiltrates.** `NIMBLE_DEBUG` emits the router ref, response *length*,
   and parsed choice only — never the raw response or copied task text. The cancel path
   emits the router ref, a cancellation marker, and the fallback target.

7. **Local routing is not local generation.** A remote-tier win sends the turn to the
   user's configured provider. The router removes one decision-layer hop; it does not
   make a remote turn private.

8. **Smallest complete change.** Prefer the fewest lines that fully satisfy the task.
   `router.ts` stays dependency-free and Pi-free so the contract is testable in
   isolation; `index.ts` is the only file that imports Pi. `compaction.ts` is likewise
   Pi-free and tested in isolation; only the `session_before_compact` bridge touches Pi.

9. **A fold fails closed, and the floor is code-enforced.** Smart compaction is opt-in
   and, on every uncertain path — router missing, timeout, cancellation, no parseable
   integer, or a summary that fails or has nothing to fold — it returns `undefined` and lets
   Pi run its own default compaction. A weak router may *suggest* a short keep-count; the
   most-recent-N floor and the `firstKeptEntryId` mapping are enforced **in code** so a fold
   can never evict the last few turns or leave the session with no summary. The router decides
   *how far back* the fold goes; the configured `local` tier writes the summary — the router
   does not. The new `compaction`/`compactionWhen`/`keepRecentTurns` fields are **non-exfil**
   (a cloned repo may tune *how much* to fold but cannot redirect *where the fold's
   judgment is made*); `EXFIL_KEYS` is unchanged.

Each item below is enforced by an assertion in `selfcheck.ts`. See
[FEATURES.md](FEATURES.md) for the feature→assertion traceability, and
[GAPS.md](GAPS.md) for what is deliberately not built yet.
