/**
 * Nimble Router - a virtual model that routes each user turn between a heavy
 * local model (ollama) and a logged-in cloud model (OpenAI / Anthropic / ...),
 * with the decision itself made by a fast local model on ollama.
 *
 * Mirrors the jev-router pattern, but the routing decision runs locally instead
 * of sending the task to an external decision gateway. A selected remote model
 * still receives the turn through the provider configured by the user.
 *
 * Register `nimble/auto`, then `--model nimble/auto` (or /model nimble/auto).
 *
 * Configure in ~/.pi/agent/settings.json (or <cwd>/.pi/settings.json, which
 * overrides global for non-exfil fields; exfil targets `cloud`/`cloudWhen` are
 * set in the global/user file only):
 *
 *   "nimbleRouter": {
 *     "router": "ollama/llama3.2:3b",        // fast local model that decides
 *     "local": "ollama/qwen3.8:27b-mlx",     // fast local tier
 *     "cloud": "anthropic/claude-sonnet-4-6",   // cheaper logged-in remote model
 *     "heavy": "anthropic/claude-opus-5-5",   // strongest remote, hardest work only
 *     "default": "local",                     // where to go on no-decision
 *     "timeoutMs": 4000,                      // router decision budget
 *     "cloudWhen": "architecture, hard debugging, cross-cutting design, research"
 *   }
 *
 * Defaults: router = local = default model. Remote targets are only used when
 * their providers are logged in; otherwise every turn stays local.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	isVirtualModel,
	type ExtensionAPI,
	type Model,
	type ModelRoute,
	type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { decide, mergeConfig, resolveConfig, split, type NimbleConfig, type RouterRegistry, type Target } from "./router.ts";
import { buildKeepPrompt, parseKeep, prunePlan, type CompactionDecision, type TurnDescriptor } from "./compaction.ts";

interface RouterState {
	target: Target | "sticky" | "direct";
}

function splitRef(ref: string, find: (provider: string, id: string) => Model | undefined | null): Model | undefined {
	const s = split(ref);
	if (!s) return undefined;
	// find can return undefined or a falsy model; treat null as missing.
	return find(s.provider, s.id) ?? undefined;
}

/** A one-line, length-bounded preview of a message's non-tool text. */
function messageHead(m: { role: string; content: unknown }): string {
	const c = m.content;
	return typeof c === "string" ? c : c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") as string;
}

/** Text length without touching tool payloads, so big outputs stay out of the descriptor. */
function contentLen(m: { role: string; content: unknown }): number {
	if (m.role === "tool" || m.role === "tool_result") return 400; // a tool result's cost is opaque; assume a chunk
	return messageHead(m).length;
}

/**
 * Group message entries into turns (one per user message), the newest to be judged by
 * the router. `firstId` is the entry id that starts the turn, so a plan can move the
 * cut to a real session boundary.
 */
function turnsFromEntries(
	entries: readonly { id: string; type?: string; message?: { role: string; content: unknown } }[],
): TurnDescriptor[] {
	const turns: TurnDescriptor[] = [];
	let cur: TurnDescriptor | null = null;
	for (const e of entries) {
		const msg = e.type === "message" ? e.message : undefined;
		if (!msg) continue;
		if (msg.role === "user") {
			cur = { turn: turns.length, firstId: e.id, chars: 0, tools: [], head: messageHead(msg).slice(0, 240) };
			turns.push(cur);
			continue;
		}
		if (!cur) continue; // stray non-user message before any user message: not a turn
		cur.chars += contentLen(msg);
		if ((msg.role === "tool" || msg.role === "tool_result")) {
			const name = ((msg as any).name ?? (msg as any).toolName) as string | undefined;
			if (name && !cur.tools.includes(name)) cur.tools.push(name);
		}
	}
	return turns;
}

/** Last user message, text only, capped. */
function lastUserText(messages: readonly Message[], cap = 12_000): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		let text: string;
		const c = m.content;
		if (typeof c === "string") text = c;
		else text = c.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
		return text.length > cap ? text.slice(0, cap) : text;
	}
	return "";
}

/** Load the `nimbleRouter` block from one settings file, or undefined. */
function loadNimble(p: string): NimbleConfig | undefined {
	if (!existsSync(p)) return undefined;
	try {
		const file = JSON.parse(readFileSync(p, "utf8"));
		const n = file?.nimbleRouter;
		return n && typeof n === "object" ? (n as NimbleConfig) : undefined;
	} catch {
		// ignore malformed settings; fall back to defaults
		return undefined;
	}
}

/**
 * Read routing config: the trusted global/user settings, merged with a project-local
 * `<cwd>/.pi/settings.json`. Project config may override non-exfil fields but can never
 * set exfil-able targets (`cloud`/`cloudWhen`) - those come from global only - so a
 * cloned repo cannot point routing at the user's logged-in cloud.
 */
function readConfig(cwd: string): NimbleConfig {
	const globalCfg = loadNimble(join(getAgentDir(), "settings.json")) ?? {};
	const projectCfg = loadNimble(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	return mergeConfig(globalCfg, projectCfg);
}

export default function (pi: ExtensionAPI) {
	// Config is read fresh per route from the current settings, so /reload picks up edits.
	pi.registerVirtualModel<RouterState>({
		provider: "nimble",
		id: "auto",
		name: "Nimble (local⇄cloud)",
		thinkingLevels: ["off", "low", "medium", "high"],
		async route(req, ctx): Promise<ModelRoute<RouterState>> {
			const cwd = ctx.cwd;
			const settings = pi.getSettings();
			const raw = readConfig(cwd);
			const cfg = resolveConfig(raw, {
				provider: settings.defaultProvider ?? "ollama",
				model: settings.defaultModel ?? "",
			});

			// Build a minimal registry view over the real one.
			const reg: RouterRegistry = {
				find: (ref) => {
					const m = splitRef(ref, (provider, id) => ctx.modelRegistry.find(provider, id));
					return m ? { provider: m.provider, id: m.id } : undefined;
				},
				hasConfiguredAuth: (m) => ctx.modelRegistry.hasConfiguredAuth({ ...m } as Model),
				complete: async (m, context, opts) => {
					const model = ctx.modelRegistry.find(m.provider, m.id);
					if (!model) return { text: "" };
					const out = await ctx.modelRegistry.complete(
						model,
						{ systemPrompt: context.systemPrompt, messages: [{ role: "user", content: context.text, timestamp: Date.now() }] },
						{ signal: opts.signal, maxTokens: opts.maxTokens, samplingParams: opts.samplingParams },
					);
					const text = out.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
					return { text };
				},
			};

			// Off-loop requests (compaction summaries, etc.) stay on the cheap local target.
			if (req.reason === "direct") {
				const local = splitRef(cfg.local, (provider, id) => ctx.modelRegistry.find(provider, id));
				if (!local) throw new Error(`nimble-router: local model ${cfg.local} not found`);
				return { model: local, thinkingLevel: req.thinkingLevel, state: { target: "direct" } };
			}

			// Tool follow-ups and retries keep the model that handled the turn (cache + signatures).
			if (req.reason !== "user") {
				const sticky = req.reason === "retry" ? req.failed?.model : req.previous?.model;
				if (sticky) return { model: sticky, thinkingLevel: req.thinkingLevel, state: { target: "sticky" } };
			}

			const decision = await decide(cfg, reg, lastUserText(req.messages), req.signal);
			if (!decision.model) {
				// Nothing usable was configured. Fall back to the active physical model if it's real.
				const fallback = ctx.model && !isVirtualModel(ctx.model) ? ctx.model : undefined;
				if (!fallback) throw new Error(`nimble-router: no usable model (${cfg.local}, ${cfg.cloud ?? "no cloud"})`);
				return { model: fallback, thinkingLevel: req.thinkingLevel, state: { target: decision.target } };
			}
			// decide() returns a minimal ref; resolve the physical Model to dispatch.
			const routed = ctx.modelRegistry.find(decision.model.provider, decision.model.id);
			const chosen = routed ?? (ctx.model && !isVirtualModel(ctx.model) ? ctx.model : undefined);
			if (!chosen) throw new Error(`nimble-router: routed model ${decision.model.provider}/${decision.model.id} not found`);
			return { model: chosen, thinkingLevel: req.thinkingLevel, state: { target: decision.target } };
		},
	});

	// Smart compaction: the local router decides how many recent turns must survive a
	// fold instead of Pi's fixed-token walk-back. Gated off by default so routing is
	// untouched; every uncertain path returns undefined, so Pi runs its own compaction.
	//
	// PI-BOUND / NOT unit-tested here: the event + result shapes come from
	// `@earendil-works/pi-coding-agent` and the turn-grouping only runs under Pi, so this
	// is checked by type + review, not by `selfcheck` (same as sticky-in-turn).
	pi.on("session_before_compact", async (event, ctx) => {
		const raw = readConfig(ctx.cwd);
		// resolveConfig's fallback model only seeds unconfigured router/local; a real physical
		// model on the session is preferred. If fully unset, find() misses and we fail closed.
		const phys = ctx.model && !isVirtualModel(ctx.model) ? ctx.model : undefined;
		const cfg = resolveConfig(raw, { provider: phys?.provider ?? "ollama", model: phys?.id ?? "" });
		if (!cfg.compaction) return; // off by default -> Pi compacts as usual
		try {
			// The router registry over the same view used for routing.
			const complete = async (ref: string, text: string, opts: { signal?: AbortSignal; maxTokens: number }): Promise<string> => {
				const m = splitRef(ref, (p, id) => ctx.modelRegistry.find(p, id));
				if (!m) return "";
				const out = await ctx.modelRegistry.complete(m, { systemPrompt: "", messages: [{ role: "user", content: text, timestamp: Date.now() }] }, opts);
				return out.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
			};

			// Turns in the region Pi KEPT (from its default cut to the end): only these can be folded
			// more. The router decides how many of THEM must stay; code enforces the floor.
			const entries = event.branchEntries;
			const cutIdx = entries.findIndex((e) => e.id === event.preparation.firstKeptEntryId);
			const keptTurns = turnsFromEntries(cutIdx >= 0 ? entries.slice(cutIdx) : entries);
			if (keptTurns.length <= 1) return; // nothing older to fold

			// One bounded local call answers the keep-count. Fail soft if the router is missing, times
			// out, or the session is cancelled; an empty reply declines and we fall back to Pi default.
			if (event.signal.aborted) return;
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			event.signal.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
			const out = await complete(cfg.router, buildKeepPrompt(keptTurns, cfg.compactionWhen), { signal: controller.signal, maxTokens: cfg.routerMaxTokens }).catch(() => "");
			clearTimeout(timer);
			event.signal.removeEventListener("abort", onAbort);

			const decision: CompactionDecision = out ? parseKeep(out) : { turns: 0, gate: false, why: "unavailable" };
			const plan = prunePlan(keptTurns, decision, cfg);
			if (!plan || plan.folded.length === 0) return; // keep everything / declined -> Pi default

			// The older kept turns now fold into the summary. Their entry range runs from Pi's cut to
			// the first still-kept turn; plus Pi's own to-summarize region. The newest survive verbatim;
			// nimble decided the cut, the configured local tier writes the summary (shortcut: a small
			// router is a weak summarizer; upgrade if `local` is strong enough to own the fold itself).
			const endIdx = entries.findIndex((e) => e.id === plan.firstKeptId);
			const foldEntries = endIdx > 0 ? entries.slice(cutIdx, endIdx) : entries.slice(cutIdx);
			const material = [event.preparation.previousSummary, ...event.preparation.messagesToSummarize.map((m: any) => messageHead(m)), ...foldEntries.map((e: any) => e.message ? messageHead(e.message) : "")].filter((s: any) => s).join("\n");
			if (!material) return; // nothing to summarize -> leave it to Pi
			const summary = await complete(cfg.local, `Compress the conversation history below into a tight summary that keeps the facts, decisions, and open tasks so the next turn can continue without the original:\n${material}`, { signal: event.signal, maxTokens: 4096 }).catch(() => "");
			if (!summary) return; // no summary -> leave it to Pi (fail closed, invariant #2)

			return {
				compaction: {
					summary,
					firstKeptEntryId: plan.firstKeptId,
					tokensBefore: event.preparation.tokensBefore,
					details: { pruned: plan.folded, keptTurns: plan.keptCount, why: "nimble" },
				},
			};
		} catch {
			return; // any failure -> Pi's default compaction (fail closed, invariant #2)
		}
	});
}
