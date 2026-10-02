// Pure routing logic for the nimble router. No Pi imports so it runs and is
// testable in isolation. The router is a fast local model (ollama) that picks
// between a heavy local model and a logged-in cloud model, per user turn.

export type Target = "local" | "cloud";

/** A physical model, as the registry hands it back. */
export interface RoutedModel {
	provider: string;
	id: string;
}

/**
 * Minimal slice of Pi's model registry that the decider needs.
 * `find`/`hasConfiguredAuth`/`complete` are structural, so the real
 * `ModelRegistry` satisfies this without any cast.
 */
export interface RouterRegistry {
	find(ref: string): RoutedModel | undefined;
	hasConfiguredAuth(model: RoutedModel): boolean;
	complete(
		model: RoutedModel,
		context: { systemPrompt?: string; text: string },
		opts: { signal?: AbortSignal; maxTokens: number; samplingParams?: Record<string, unknown> },
	): Promise<{ text?: string }>;
}

export interface NimbleConfig {
	/** Local, fast model that makes the routing decision. `provider/id`. */
	router?: string;
	/** Heavy local model to route to. `provider/id`. */
	local?: string;
	/** Cloud model to route to when the task needs it. `provider/id`. */
	cloud?: string;
	/** Where to send a turn when no decision is made. Default: "local". */
	default?: Target;
	/** Router decision budget in ms. Default: 15000. Raise only if your router reasons for the whole budget. */
	timeoutMs?: number;
	/** Max output tokens for the router call. Default: 32 - enough to reach a one-word verdict. */
	routerMaxTokens?: number;
	/** Natural-language guidance for when to prefer the cloud model. */
	cloudWhen?: string;
	/**
	 * Sampling params for the router call. Default `{ reasoning_effort: "none", temperature: 0 }`:
	 * suppression makes an ollama thinking model put the verdict in `content` (~0.1s) instead of an
	 * empty reply, and temperature 0 makes the one-word choice deterministic. Best-effort / portable;
	 * ignored where unsupported. Set `{}` to let a model think, or add model-specific keys.
	 */
	routerOptions?: Record<string, unknown>;
}

export interface ResolvedConfig {
	router: string;
	local: string;
	cloud?: string;
	fallback: Target;
	timeoutMs: number;
	cloudWhen?: string;
	routerMaxTokens: number;
	routerOptions: Record<string, unknown> | undefined;
}

export interface Decision {
	/** Chosen physical model, or undefined when nothing usable was configured. */
	model: RoutedModel | undefined;
	target: Target;
	/** How the decision was reached. */
	why: "router" | "no-cloud" | "fallback" | "unconfigured";
}

export function split(ref: string): { provider: string; id: string } | undefined {
	const at = ref.indexOf("/");
	if (at <= 0 || at === ref.length - 1) return undefined;
	return { provider: ref.slice(0, at), id: ref.slice(at + 1) };
}

export function resolveConfig(config: NimbleConfig, defaults: { provider: string; model: string }): ResolvedConfig {
	const fallbackModel = `${defaults.provider}/${defaults.model}`;
	return {
		router: config.router ?? fallbackModel,
		local: config.local ?? fallbackModel,
		cloud: config.cloud,
		fallback: config.default ?? "local",
		timeoutMs: config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 15000,
		cloudWhen: config.cloudWhen,
		routerMaxTokens: config.routerMaxTokens && config.routerMaxTokens > 0 ? config.routerMaxTokens : 32,
		// Defaults: suppress thinking (verdict lands in `content`) + temperature 0 for a deterministic pick.
		routerOptions: config.routerOptions ?? { reasoning_effort: "none", temperature: 0 },
	};
}

/** Parse the router's answer into a target, or undefined when it gave no clear choice.
 *  Prefers the LAST occurrence: a thinking model narrates first, so its verdict lands last. */
export function parseDecision(text: string): Target | undefined {
	const t = text.toLowerCase();
	const cloud = t.lastIndexOf("cloud");
	const local = t.lastIndexOf("local");
	if (cloud === -1 && local === -1) return undefined;
	if (cloud === -1) return "local";
	if (local === -1) return "cloud";
	return cloud > local ? "cloud" : "local";
}

function buildPrompt(userText: string, cloudWhen?: string): string {
	const when = cloudWhen ? `Prefer local; send to cloud only when: ${cloudWhen}\n` : "";
	return [
		"You route a coding task to a model. Decide whether it needs the strong remote model (cloud) or the cheaper local model (local).",
		when,
		`Task:\n${userText}`,
		"On its own final line, reply with exactly one word: local or cloud.",
	].join("\n");
}

/** Pick a target for one request. Never throws; failures fall back to `fallback`. */
export async function decide(
	config: ResolvedConfig,
	reg: RouterRegistry,
	userText: string,
	signal?: AbortSignal,
): Promise<Decision> {
	const local = reg.find(config.local);
	if (!local) return { model: undefined, target: "local", why: "unconfigured" };

	// No cloud target, or it isn't logged in: stay local.
	const cloud = config.cloud ? reg.find(config.cloud) : undefined;
	if (!cloud || !reg.hasConfiguredAuth(cloud)) return { model: local, target: "local", why: "no-cloud" };

	const router = reg.find(config.router);
	if (!router) {
		const target = config.fallback;
		return { model: target === "cloud" ? cloud : local, target, why: "fallback" };
	}

	// Decide with the fast local router. Bounded, and it fails soft to the fallback.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	let answer: string;
	try {
		const out = await reg
			.complete(router, { text: buildPrompt(userText, config.cloudWhen) }, {
				signal: controller.signal,
				maxTokens: config.routerMaxTokens,
				samplingParams: config.routerOptions,
			})
			.then((r) => r.text ?? "");
		if (process.env.NIMBLE_DEBUG)
			console.error(JSON.stringify({ router: config.router, opts: config.routerOptions, out, choice: parseDecision(out ?? "") }));
		answer = out;
	} catch {
		answer = "";
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}

	const choice = parseDecision(answer);
	const target: Target = choice ?? config.fallback;
	const model = target === "cloud" ? cloud : local;
	// Router produced a clear choice = "router"; an empty/ambiguous answer fell through to fallback.
	return { model, target, why: choice ? "router" : "fallback" };
}
