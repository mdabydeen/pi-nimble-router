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

interface RouterState {
	target: Target | "sticky" | "direct";
}

function splitRef(ref: string, find: (provider: string, id: string) => Model | undefined | null): Model | undefined {
	const s = split(ref);
	if (!s) return undefined;
	// find can return undefined or a falsy model; treat null as missing.
	return find(s.provider, s.id) ?? undefined;
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
}
