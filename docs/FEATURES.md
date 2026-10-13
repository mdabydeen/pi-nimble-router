# Features

Source of truth for what the router does and the `selfcheck.ts` assertion that
proves each behavior. Add a row when a behavior changes; when a new exfil-able
field appears, add it to `EXFIL_KEYS` in `router.ts` and the lock assertion will
catch the change.

## Routing

| Feature | Assertion in `selfcheck.ts` |
|---|---|
| Three-tier ladder `local` / `cloud` / `heavy` | "three-tier ladder" (heavy verdict → strong model when logged in) |
| `heavy` → `cloud` → `local` downgrade when a tier isn't logged in | "heavy requested but not logged in" |
| No logged-in remote at all ⇒ stay local (router not called) | "no cloud configured → local" |
| Router "cloud" routes to cloud; "local" routes to local | "cloud answered cloud", "cloud answered local" |
| Ambiguous/empty router answer ⇒ configured `default` | "ambiguous answer → falls back" |
| Router model missing ⇒ fallback, no `complete()` attempt | "router model missing → fallback target" |
| `cloud` not authenticated ⇒ local (`why: no-cloud`) | "cloud not authenticated → local" |
| `complete()` throws ⇒ fallback, never throws | "complete() throws → falls back" |

## Loop stability

| Feature | Assertion |
|---|---|
| Continuations/retries keep the turn's model (`sticky`); `direct` goes local | enforced in `index.ts` `route()`; not unit-tested (Pi-bound) |
| Config re-read per route so `/reload` applies | enforced in `index.ts`; not unit-tested (Pi-bound) |

## Cancellation

| Feature | Assertion |
|---|---|
| Already-cancelled request skips the router, fails soft to `default` | "signal already aborted before entry" |
| Mid-flight cancel cuts the live call, fails soft to fallback | "abort mid-flight" |
| Cancel path logs one redacted record with `cancelled:true` | "cancel path emits a redacted debug record" |

## Decision budget

| Feature | Assertion |
|---|---|
| A router that ignores `timeoutMs` is cut and fails soft to fallback | "router ignores the timeout budget" |
| `routerOptions` forwarded to the router call | "forward routerOptions" |
| `resolveConfig` defaults (fallback=local, timeoutMs=15000, routerMaxTokens=32, default routing options) | "resolveConfig defaults + fallback" |

## Parsing / injection

| Feature | Assertion |
|---|---|
| Only the router's final line is parsed; last token wins | "parseDecision: only the router's FINAL line is parsed" |
| Punctuation/quotes around a verdict still parse; CRLF split handled | same block |
| A routing token on an earlier (data) line is ignored | "routing token on an earlier (data) line is ignored" |
| No clean final-line verdict ⇒ `undefined` (fails closed) | "no verdict on final line → undefined" |
| `buildPrompt` delimits untrusted input into the router prompt | "buildPrompt delimits untrusted input" |

## Smart compaction

The `nimbleRouter.compaction` opt-in replaces Pi's fixed-token walk-back: the local router decides
**how many recent turns a fold must keep**; a stronger local tier writes the summary; every uncertain
path returns nothing so Pi runs its own compaction. Off by default, so routing is untouched.

| Feature | Assertion in `selfcheck.ts` |
|---|---|
| A bare `4` keeps the last 4 turns; the fold runs to those turns | "parseKeep: bare integer" ... "prunePlan: floor / no-fold" |
| Only the final line is parsed; last integer wins, punctuation tolerated | "parseKeep: final line / last integer / punctuation" |
| A clean no-fold word (`no`/`none`/`skip`/`unsafe`) ⇒ keep everything | "parseKeep: clean no-fold word", "none" |
| No integer ⇒ unparseable ⇒ fold nothing (fail closed) | "unparseable → gate: false", "empty", "zero keep" |
| The most-recent-N floor is enforced; the fold keeps the newest | "prunePlan: floor is enforced", "explicit floor" |
| Fold region = Pi's to-summarize + the extra kept turns dropped | `prunePlan.folded`/`firstKeptId` assertions |
| Compaction off by default; only a positive `keepRecentTurns` is honored | "config compaction gating" |
| Compaction fields are **not** exfil; `EXFIL_KEYS` stays locked | "exfil key set still locked" |
| Offline eval: a simulated verdict frees ~38–51% of context and declines stay safe | "compaction selfcheck (offline eval)" prints in `selfcheck` |

## Smart skills selection

The `nimbleRouter.skills` opt-in lets the local router pick the one installed `SKILL.md` that fits
the turn and load it, instead of the main model deciding. Off by default, so routing is untouched; a
clean decline, a name not in the catalog, a timeout, a cancel, or an unreadable file all leave the
input as-is. The loaded skill is a local file, so this adds no exfil field.

| Feature | Assertion in `selfcheck.ts` |
|---|---|
| A final-line name routes to that skill; case-insensitive | "a final-line name routes to that skill", "case-insensitively" |
| Only the router's final line is read; an injected name on a data line is ignored | "final line beats an injected earlier name" |
| Last known token wins; a name not in the catalog cannot load | "last known token wins", "a name not in the catalog cannot load" |
| A clean decline or empty reply names nothing (fail closed) | "a clean decline names nothing", "empty input names nothing" |
| A hyphenated name is one token; a bare substring can't win it | "a bare substring is not the hyphenated name", "the whole hyphenated name matches" |
| `buildSkillPrompt` delimits the untrusted task and offers `none` | "prompt marks the task as untrusted" ... "markers wrap the task text in order" |
| Selection is off by default; only boolean `true` opts in | "skill selection is OFF by default", "only boolean true opts in" |
| `skills`/`skillWhen` are **not** exfil; `EXFIL_KEYS` stays locked | "exfil key set stays locked with skills added" |

| Feature | Assertion |
|---|---|
| Project-local config can override non-exfil fields only | "mergeConfig: project-local config may override non-exfil fields" |
| Project cannot set `cloud`/`cloudWhen`/`heavy` or redirect `router` | same + "a project cannot redirect the router" |
| `EXFIL_KEYS` is exactly `{router, cloud, heavy, cloudWhen}` and honored | "exfil key set is locked" |
| Debug output never echoes copied task text | "debug output: retain routing metadata without echoing copied task text" |
