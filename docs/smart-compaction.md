# Smart compaction

**Status: implemented.** `compaction.ts` is unit-tested in `selfcheck` (verdict parser,
floor-enforcing fold plan, prompt delimiting, config scoping, plus an offline eval). The
`session_before_compact` bridge in `index.ts` is Pi-bound and **not** unit-tested here (same
status as sticky-within-a-turn; no integration harness). The judgment call in the live
bridge is `cfg.router`; the summary is written by `cfg.local`. Off by default (`compaction`
unset; a weak router only *suggests*, floor + fail-closed enforced in code).

**What shipped vs. this design:** the verdict is a single *keep-count* (`parseKeep` returns
an integer / `no`), not a per-`knownIds` keep-list, and the hard floor is the
most-recent-N turns only (a `fileOps` lock and a two-call re-check are deferred to
GAPS). The rest — one bounded router call, fail-closed on every path, `local` authors the
summary, non-exfil config — is as described below.

Originally a plan for a second nimble judgment: when Pi compacts a session, let the local
router decide **what to keep and what to fold away**, instead of the default
blind token walk-back. Modeled on TypeSafe's re-ranking / skill-suggestion
cookbook shape — *fast deterministic shortlist → one semantic judgment →
threshold in code* — but the judgment runs on the **local** `router` model.
No Jev, no TypeSafe call.

**This is a plan.** The contract below is the shape; nothing is implemented yet.

## 1. The finding behind it

Pi's built-in compaction (`prepareCompaction` → `findCutPoint`) walks the
transcript backward and keeps the most recent `keepRecentTokens`, then a
configured model summarizes everything older. It is a **heuristic that ignores
value**: it keeps "recent" regardless of whether an element still matters, and it
can cut through a load-bearing turn.

Two facts make a smarter cut cheap to add:

- **`session_before_compact` is fully controllable.** Returning `{ compaction }`
  from that event makes Pi skip its own summary and persist exactly the
  extension's `summary` + `firstKeptEntryId` + `tokensBefore` + `details`
  (`agent-session.js` `compact()`). Both `/compact` and automatic
  threshold/overflow compaction go through the hook.
- **The judgment primitives are public** from `@earendil-works/pi-coding-agent`:
  `compact`, `generateSummary`, `findCutPoint`, `estimateTokens`,
  `CompactionResult`, `SessionBeforeCompactEvent`, `SessionBeforeCompactResult`.
  The event's `preparation` already hands us Pi's `messagesToSummarize`,
  `turnPrefixMessages`, `firstKeptEntryId`, `previousSummary`, `fileOps`,
  `settings`, `branchEntries`.

## 2. The limit that shapes the design

`CompactionResult` is a **contiguous prefix cut**: everything at/after
`firstKeptEntryId` survives verbatim, everything before it is replaced by
`summary`. You **cannot keep an old element while dropping a newer one.** So
"which tools and conversation elements to prune" is expressible today only as:

- **how far back the cut goes** (nimble pushes the cut point), and
- **what the summary says / omits** (nimble informs the fold).

Genuinely *sparse* retention (keep this old tool output, drop the one after it)
needs a per-message keep-list API Pi does not yet expose. **Deferred — see
§8.** v1 is the prefix-cut + summary-inform surface.

## 3. Jev pattern, localized

The re-ranking cookbook is the template:

| Step | Jev cookbook | v1 (local) |
|---|---|---|
| Fast search (code) | BM25 shortlist of 30 | Pi's `preparation.messagesToSummarize` + `findTurnStartIndex` turn boundaries + deterministic `fileOps` / recent-turn marks |
| Judgment (model) | one `Noul`/`Choice` per candidate | **one** local `router` call returning a keep-list, over compact element *descriptors* (not raw content) |
| Gate (code) | `gate ≥ 0.30` | a "safe to prune at all?" gate; **no ⇒ fail closed to Pi default** |
| Assemble (code) | sort by noul, threshold | move `firstKeptEntryId`, generate `summary`, carry `details` |

Two deviations from the cookbook, both deliberate:

- **One call, not two.** Skill-suggestion spends two calls (rank all, re-read
  top 3). Compaction fires rarely and is budget-bounded; one call is enough for
  v1. Keep the split as a GAPS option.
- **Nimble judges, a stronger model summarizes.** The `router` is a small fast
  model (default `llama3.2:3b`). It judges *which* turns to keep; it does **not**
  author the summary. The summary is produced by the configured `local` tier via
  `compact()`/`generateSummary()`. A 3B model is unqualified to re-summarize a
  20k-token fold; keep the split. A `compaction: "full"` mode (nimble authors the
  summary) is recorded as opt-in-only and sane only when `local` is strong.

## 4. The contract

### New pure module `compaction.ts` (no Pi, no ollama imports; selfcheck-tested)

Mirrors `router.ts` discipline: dependency-free, total parsers, fail-closed.

```ts
/** One candidate to keep or fold, reduced from a transcript entry. */
export interface ElementDescriptor {
  id: string;            // session entry id
  role: "user" | "assistant" | "tool";
  tool?: string;         // for tool results, the tool name (grep/read/edit/…)
  chars: number;         // size; bounds the descriptor, not raw content
  head: string;          // short, truncated preview — the only untrusted text in the prompt
  turn: number;          // turn index (from findTurnStartIndex)
}

/** What nimble answers, parsed. `keep` is an ordered list of descriptor ids. */
export interface CompactionDecision {
  keep: string[];        // ids to keep verbatim; the rest fold into the summary
  gate: boolean;         // "is anything here safe to fold away?"
  why: "judge" | "no-gate" | "unparseable" | "unavailable";
}

/** Compute the cut point + which descriptors fold, from a decision. */
export function prunePlan(
  descriptors: ElementDescriptor[],
  decision: CompactionDecision,
  locked: ReadonlySet<string>,   // recent N turns + fileOps touch — never pruned, by code
): { firstKeptId: string; folded: string[]; prunedChars: number } | undefined;

export function parseKeepList(text: string, knownIds: ReadonlySet<string>): CompactionDecision;
export function buildKeepPrompt(descriptors: ElementDescriptor[], gate?: string): string;
```

Parser rules (identical discipline to `parseDecision` in `router.ts`):

- Only the **final non-empty line** of the router answer is read; earlier lines
  (narration, or an injected `keep`/`gate` token) are never consulted.
- The keep-list line names ids from `knownIds`; ids it lists are kept, the rest
  fold. Trailing noise that is not a clean list ⇒ `unparseable` ⇒ fail closed.
- `fileOps` files and the most-recent `keepRecentTurns` are in `locked` and
  **pruned from the decision in code**: the router can propose, code enforces the
  floor. A later edit that re-opens a `read`/`edit` result must not be lost.

### `index.ts` bridge (the only Pi-touching change)

Register one handler:

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const cfg = readConfig(ctx.cwd);                     // reuse the exfil-scoped loader
  if (!cfg.compaction) return;                         // off by default → Pi runs default
  const descriptors = reduce(event.preparation, event.branchEntries);
  const decision = await judge(cfg, reg, descriptors, event.signal); // via RouterRegistry.complete
  if (!decision.gate) return;                          // fail closed → Pi default
  const plan = prunePlan(descriptors, decision, locked(descriptors, event.preparation));
  if (!plan) return;                                   // nothing safe to cut → Pi default
  // nimble decided the cut; the configured `local` tier writes the summary
  const result = await compact({ ...event.preparation, firstKeptEntryId: plan.firstKeptId },
                               ctx.model, ctx... );     // public compact()
  result.details = { pruned: plan.folded, why: "nimble" }; // artifact index, for `session_compact`
  return { compaction: result };
});
```

`judge()` reuses the existing `RouterRegistry.complete` (the same call the router
uses), with the **same** timeout + cancel + fail-soft machinery as `decide()`.
Any failure — no `router`, timeout, unparseable, `compact()` throws — returns
`undefined` and Pi takes its default path. The extension never leaves the session
without a summary.

## 5. Config (additive, reuses exfil scoping)

Add to `NimbleConfig` / `resolveConfig`, all **non-exfil** (compaction runs off the
router path, but the router *call transmits element previews unauth-gated*, so the
`router` target's exfil protection already covers the data it sees — no new exfil
field needed, so `EXFIL_KEYS` **does not** change):

| field | meaning | default |
|---|---|---|
| `compaction` | `false` (Pi default) \| `true` (nimble sets the cut; `local` summarizes; `"full"`/heavy-summarizer = future) | `false` |
| `compactionWhen` | natural-language hint for when folding is safe | none |
| `keepRecentTurns` | hard floor: the N most recent turns are never folded | `3` |

`compaction`/`compactionWhen`/`keepRecentTurns` are project-overridable (non-exfil),
so a cloned repo could tune but **cannot** point the `router` that reads previews at
a cloud — that still comes from global only, unchanged.

## 6. Fail-closed / security (constitution alignment)

| Invariant | How it holds |
|---|---|
| #2 Fail closed | every failure path returns `undefined` → Pi's default compaction; the session is never left without a summary |
| #3 Exfil scoping | no new exfil field; the `router` target (an `EXFIL_KEY`) already gates the only call that sees element text |
| #5 Final-line verdict | `parseKeepList` reads only the router's final line; element previews are wrapped in `UNTRUSTED DATA` / `<<< … >>>` markers like `buildPrompt` |
| Hard floor (code, not judgment) | `locked` = most-recent `keepRecentTurns` ∪ `fileOps` files; the router can suggest, code enforces |
| #6 Debug never exfiltrates | `NIMBLE_DEBUG` logs ids, `prunedChars`, and the parsed decision — never a preview or the raw answer |

## 7. Test plan (new block in `selfcheck.ts`)

Pure, deterministic, no ollama — same style as the router block:

- `parseKeepList`: only the final line counts; a `keep` token on an earlier (data)
  line is ignored; punctuation/quotes parse; an id not in `knownIds` is dropped;
  malformed ⇒ `unparseable`; empty ⇒ `gate:false`.
- `prunePlan`: `locked` ids never fold; `prunedChars` is the sum of folded sizes;
  `firstKeptId` lands after the last kept id; empty keep ⇒ `undefined`.
- `reduce`/`locked`: `fileOps.read`/`edited` and the last `keepRecentTurns` turns
  are locked; tool names and turns come off the entry.
- gating: `compaction !== true` returns `undefined` (Pi default); a
  `gate:false` decision returns `undefined`; `compact()` throwing returns
  `undefined` (never re-thrown).

## 8. GAPS / deferrals (record, don't build)

- **Sparse per-element retention.** `CompactionResult` is a prefix cut; keeping an
  old element while dropping a newer one needs a per-message keep-list API from Pi
  (a `ContextEditEntry`-style primitive). *(Trigger: Pi exposes it, or a user
  repeatedly hits a case where a stale-but-useful old result must survive a newer
  fold.)*
- **Two-call variant** (rank all, re-read top-k). Only if one call's keep-list
  quality is the bottleneck. *(Trigger: a quality measurement, not a guess.)*
- **Nimble-authored summary (`compaction: "full"`).** Opt-in, sane only when
  `local` is a strong model; default is `"decide"`.
- **Per-session telemetry** of what was folded and how much context was saved.
  *(Trigger: adopters ask; behind a flag, never on by default — matches GAPS.md.)*

## 9. Rollout

`compaction` defaults to `false`, so the virtual model and existing routing are
**untouched**; users opt in per session. When on, the footer can show the folded
count / saved tokens from `result.details`, like it already shows the routed model.
No new service, no new dependency — the decision is one local `router` call the
package already makes every turn.
