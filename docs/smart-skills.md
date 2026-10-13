# Smart skills selection

**Status: implemented.** `skills.ts` is unit-tested in `selfcheck` (the catalog-bounded verdict
parser, the prompt delimiting, config scoping). The `input` bridge in `index.ts` is Pi-bound and
**not** unit-tested here (no tsc / integration harness; same status as the compaction and sticky
bridges). The judgment runs on the **local** `router` model. Off by default (`skills` unset), so
routing is untouched.

## What it is

Pi advertises every installed skill by name + description and the *main* model loads a
`SKILL.md` when it thinks the task matches — "A model might fail to load a relevant skill."
Smart selection moves that choice to the router: on each user turn the local router picks the one
installed `SKILL.md` that fits and its instructions are loaded into the turn, so a missed skill is
found even by a small main model.

## The contract

### Pure module `skills.ts` (no Pi, no ollama imports; selfcheck-tested)

Mirrors `router.ts` / `compaction.ts`: dependency-free, total parser, fail-closed.

```ts
export interface SkillDescriptor { name: string; description: string; }

export interface SkillDecision {
  skill: string | undefined;  // a known skill name, or undefined on decline / no-match / failure
  why: "judge" | "none" | "unparseable" | "unavailable";
}

// Bounded to `skills`; the final non-empty line only; last known token wins.
export function parseSkillVerdict(text: string, skills: readonly SkillDescriptor[]): SkillDecision;
export function buildSkillPrompt(userText: string, skills: readonly SkillDescriptor[], when?: string): string;
```

Parser discipline (identical to `parseDecision` / `parseKeep`):

- Only the router's **final non-empty line** is read; a skill name on an earlier (narration / pasted
  data) line is never consulted, so it cannot steer the load.
- The verdict is checked **against the installed catalog**: a name not in the catalog cannot load, so
  the router (and pasted content) can neither exfiltrate nor smuggle a skill name.
- The **last** known token on the final line wins. Hyphenation is token-stable: `find-skills` is one
  token, a bare `find` can neither win nor fragment it, so a short name can't shadow a long one.
- A clean decline (`no`/`none`/`skip`/`keep all`) or no clean verdict names no skill → fail closed.

### `index.ts` bridge (the only Pi-touching change)

```ts
pi.on("input", async (event, ctx) => {
  if (event.source === "extension") return;      // don't re-select on text we injected
  const cfg = readConfig(ctx.cwd);
  if (!cfg.skills) return;                        // off by default -> input flows as usual
  const catalog = skillCatalog(ctx.cwd);          // loadSkills(...), model-invocable only
  if (!catalog.length) return;
  const out = /* one bounded router call, reuse timeout + cancel machinery */;
  const decision = out ? parseSkillVerdict(out, catalog) : { skill: undefined, why: "unavailable" };
  if (!decision.skill) return;                    // none / unparseable -> leave the input (fail closed)
  const body = stripFrontmatter(readFileSync(chosen.filePath, "utf8"));
  return { action: "transform", text: `<!-- nimble-skill: ${chosen.name} -->\n${body}\n\n${event.text}` };
});
```

The chooser *injects the SKILL.md body* (frontmatter stripped) as a `<!-- nimble-skill: name -->`
preamble rather than dispatching `/skill:name` — the `input` transform does not re-run command
expansion, and a re-entry guard skips that marker. A read failure declines.

## Config (additive, non-exfil)

| field | meaning | default |
|---|---|---|
| `skills` | opt-in; the router picks and loads the one skill that fits each turn | `false` |
| `skillWhen` | natural-language hint for when to prefer a skill | none |

Both are **non-exfil** and project-overridable: a loaded skill is a local file, so no new cloud
target appears and `EXFIL_KEYS` is unchanged. The one router call that sees the task text is still
the exfil-protected `router` target, and it reuses the same `timeoutMs` / cancel / `routerOptions`
machinery as `decide()`.

## Fail-closed / security

| Invariant | How it holds |
|---|---|
| Fail closed | every uncertain path — no catalog, no verdict, unknown name, unreadable file, timeout, cancel — leaves the `input` untouched; the turn proceeds as if the feature were off |
| Exfil scoping | no new exfil field; `EXFIL_KEYS` stays `{ router, cloud, heavy, cloudWhen }`; a project may opt in but cannot redirect the `router` |
| Catalog-bounded | the verdict must name an installed skill; a name pasted into the task or emitted off-catalog loads nothing |
| Final-line verdict | `parseSkillVerdict` reads only the router's own final line; pasted content is wrapped in `UNTRUSTED DATA` / `<<< TASK BEGIN … TASK END >>>` markers |

## GAPS / deferrals

See [`GAPS.md`](GAPS.md#smart-skills-selection-the-input-bridge): the live bridge is type-checked
not integration-tested; selection is a separate judgment from the tier verdict; and the catalog uses
default + cwd discovery only.
