// Model API Inspector — pairs each provider round-trip (request → response →
// parsed assistant message) into a single panel in the TUI chat area, so you
// can see exactly what pi sends to the model and what comes back.
//
// Scope: only provider calls since the most recent user input are shown.
// This keeps the inspector focused on the current turn, even when the user
// sends a steering/follow-up message while the agent is still running.
//
// Replaces the older split model-api-request.ts / model-api-response.ts.
// Place in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local).
//
// Views (a call renders at whichever depth the message is expanded to):
//   collapsed  one dense line:  API provider/model status latency ↑in ↓out ⚡cache% cost time
//   expanded   + metrics block: url, status, latency, request id, stop reason, notable headers, then raw JSON
// Behaviour is controlled entirely by the CONFIG block below.

import type { Usage } from "@earendil-works/pi-ai";
import { highlightCode, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "model-api-inspector";

// ─── Configuration ──────────────────────────────────────────────────────────
// Edit these defaults to change what the inspector shows.
const CONFIG = {
	/** Most recent calls to render per turn. Infinity shows all. */
	maxCalls: 5,
	/** Truncate every string in the raw JSON to this length. 0/Infinity = no truncation. */
	maxStringLen: 50,
	/** Show the raw request/response JSON in the expanded view. */
	showRaw: true,
	/** JSON paths to collapse to a placeholder. Rooted and dot-separated; append [] to a
	 *  key to enter every element of that array. Case-sensitive, exact (no wildcards beyond
	 *  []). e.g. "tools", "messages[].content", "a.b.c". */
	hidePaths: ["tools"],
	/** Response headers worth surfacing (rate limits, request ids, retry hints). */
	headerFilter: /ratelimit|rate-limit|retry-after|request-id/i,
};

interface AssistantMessageLike {
	role?: string;
	usage?: Usage;
	responseId?: string;
	responseModel?: string;
	stopReason?: string;
}

interface ApiCall {
	provider: string;
	model: string;
	url: string;
	requestPayload: unknown;
	requestAt: number;
	// filled on after_provider_response
	status?: number;
	headers?: Record<string, string>;
	responseAt?: number;
	// filled on the assistant message_end
	usage?: Usage;
	responseId?: string;
	responseModel?: string;
	stopReason?: string;
	assistantMessage?: unknown;
	messageAt?: number;
}

interface InspectorDetails {
	calls: ApiCall[];
}

// ─── URL / formatting helpers ────────────────────────────────────────────────
function getApiEndpoint(api: string): string {
	switch (api) {
		case "anthropic-messages":
			return "/messages";
		case "openai-completions":
		case "mistral-conversations":
			return "/chat/completions";
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return "/responses";
		default:
			return "";
	}
}

function joinUrl(base: string, path: string): string {
	const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
	return path ? `${trimmed}${path}` : trimmed;
}

function hiddenMarker(value: unknown): string {
	if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"} hidden]`;
	if (value !== null && typeof value === "object") return `[${Object.keys(value).length} keys hidden]`;
	return "[hidden]";
}

// A hide-path is a list of steps: an object key, or `[]` (match any array index).
type PathStep = { key: string } | { iter: true };

/** Parse "messages[].content" → [{key:"messages"}, {iter}, {key:"content"}]. */
function parseHidePath(spec: string): PathStep[] {
	const steps: PathStep[] = [];
	for (const token of spec.split(".")) {
		const [, base = "", brackets = ""] = token.match(/^(.*?)((?:\[\])*)$/) ?? [];
		if (base) steps.push({ key: base });
		for (let i = 0; i < brackets.length; i += 2) steps.push({ iter: true });
	}
	return steps;
}

/** True when a concrete location (object keys as strings, array indices as numbers)
 *  is exactly the given hide-path — `[]` steps match any index. */
function pathMatches(path: (string | number)[], pattern: PathStep[]): boolean {
	if (path.length !== pattern.length) return false;
	return pattern.every((step, i) =>
		"iter" in step ? typeof path[i] === "number" : path[i] === step.key,
	);
}

/** Produce a serialization-safe copy of `value`: truncate long strings and collapse
 *  any node whose path matches an entry in `hidePaths`. Returns `value` as-is (no copy)
 *  when there is nothing to truncate or hide. */
function sanitize(
	value: unknown,
	maxStringLen: number,
	hidePaths: PathStep[][],
	path: (string | number)[] = [],
): unknown {
	const truncating = Number.isFinite(maxStringLen) && maxStringLen > 0;
	if (!truncating && hidePaths.length === 0) return value;
	if (typeof value === "string") {
		return truncating && value.length > maxStringLen ? `${value.slice(0, maxStringLen)}…` : value;
	}
	const child = (val: unknown, seg: string | number) => {
		const childPath = [...path, seg];
		return hidePaths.some((p) => pathMatches(childPath, p))
			? hiddenMarker(val)
			: sanitize(val, maxStringLen, hidePaths, childPath);
	};
	if (Array.isArray(value)) {
		return value.map((item, i) => child(item, i));
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) result[key] = child(val, key);
		return result;
	}
	return value;
}

function formatPayload(payload: unknown, maxStringLen: number, hidePaths: PathStep[][]): string {
	const clean = sanitize(payload, maxStringLen, hidePaths);
	try {
		return JSON.stringify(clean, null, 2);
	} catch {
		return String(clean);
	}
}

function fmtTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return String(n);
}

function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

/** Render a full-width section header with a rule, e.g. "  → REQUEST ───────". */
function sectionHeader(title: string, width: number): string {
	const prefix = "  ";
	const pad = Math.max(0, width - prefix.length - title.length);
	return truncateToWidth(`${prefix}${title}${"─".repeat(pad)}`, width);
}

/** Total latency (request → assistant message), falling back to time-to-headers. */
function latencyMs(call: ApiCall): number | undefined {
	const end = call.messageAt ?? call.responseAt;
	return end !== undefined ? end - call.requestAt : undefined;
}

function cacheHitPct(u: Usage): number | undefined {
	const denom = u.input + u.cacheRead;
	return denom > 0 ? (u.cacheRead / denom) * 100 : undefined;
}

// ─── Rendering ───────────────────────────────────────────────────────────────
interface RenderOpts {
	expanded: boolean;
	showRaw: boolean;
	maxCalls: number;
	maxStringLen: number;
	hidePaths: PathStep[][];
	headerFilter: RegExp;
}

class InspectorComponent implements Component {
	private cacheWidth = -1;
	private cacheSig = "";
	private cacheLines: string[] = [];

	constructor(
		private calls: ApiCall[],
		private opts: RenderOpts,
		private theme: Theme,
	) {}

	private summaryLine(call: ApiCall): string {
		const t = this.theme;
		const statusColor = call.status === undefined ? "dim" : call.status < 300 ? "success" : "error";
		const status = call.status === undefined ? "…" : String(call.status);

		const parts = [
			t.fg("toolTitle", t.bold("API")),
			t.fg("accent", `${call.provider}/${call.model}`),
			t.fg(statusColor, status),
		];

		const lat = latencyMs(call);
		if (lat !== undefined) parts.push(t.fg("muted", fmtDuration(lat)));

		if (call.usage) {
			const u = call.usage;
			parts.push(t.fg("muted", `↑${fmtTokens(u.input + u.cacheRead)} ↓${fmtTokens(u.output)}`));
			const hit = cacheHitPct(u);
			if (hit !== undefined && u.cacheRead > 0) parts.push(t.fg("success", `⚡${Math.round(hit)}%`));
			if (u.cost) parts.push(t.fg("muted", fmtCost(u.cost.total)));
		}

		parts.push(t.fg("dim", new Date(call.requestAt).toLocaleTimeString()));
		return parts.join(" ");
	}

	private metricsLines(call: ApiCall, innerWidth: number): string[] {
		const t = this.theme;
		const meta = (s: string) => t.fg("muted", s);
		const lines: string[] = [meta(`  POST ${call.url}`)];

		// status · latency · reqId · stop
		const parts: string[] = [];
		if (call.status !== undefined) parts.push(`status ${call.status}`);
		const lat = latencyMs(call);
		if (lat !== undefined) parts.push(`latency ${fmtDuration(lat)}`);
		const reqId = call.responseId;
		if (reqId) parts.push(`id ${reqId}`);
		if (call.stopReason) parts.push(`stop ${call.stopReason}`);
		if (call.responseModel && call.responseModel !== call.model) parts.push(`→ ${call.responseModel}`);
		if (parts.length) lines.push(meta(`  ${parts.join(" · ")}`));

		// notable headers
		if (call.headers) {
			for (const [k, v] of Object.entries(call.headers)) {
				if (this.opts.headerFilter.test(k)) lines.push(meta(`  ${k}: ${v}`));
			}
		}

		return lines.map((l) => truncateToWidth(l, innerWidth));
	}

	private rawLines(label: string, color: "accent" | "success", payload: unknown, innerWidth: number): string[] {
		const t = this.theme;
		const out: string[] = [t.fg(color, sectionHeader(label, innerWidth))];
		const json = formatPayload(payload, this.opts.maxStringLen, this.opts.hidePaths);
		for (const line of highlightCode(json, "json")) {
			out.push(truncateToWidth(line, innerWidth));
		}
		return out;
	}

	render(width: number): string[] {
		// render() runs on every repaint, but the calls only change a handful of
		// times per turn. Skip the work (notably re-running highlightCode over the
		// raw JSON) when nothing affecting output has changed since the last render.
		const sig = this.signature();
		if (width === this.cacheWidth && sig === this.cacheSig) return this.cacheLines;
		this.cacheWidth = width;
		this.cacheSig = sig;
		this.cacheLines = this.build(width);
		return this.cacheLines;
	}

	/** Cheap fingerprint of everything build() reads that mutates while the panel is
	 *  live: the call count plus each call's progressively-filled state fields. `expanded`
	 *  is fixed per instance (a toggle rebuilds the component), so it need not be tracked. */
	private signature(): string {
		return this.calls.map((c) => `${c.status ?? ""}/${c.responseAt ?? ""}/${c.messageAt ?? ""}`).join("|");
	}

	private build(width: number): string[] {
		const container = new Container();
		const shown = Number.isFinite(this.opts.maxCalls) ? this.calls.slice(-this.opts.maxCalls) : this.calls;

		for (const call of shown) {
			const bgColor = this.opts.expanded
				? "customMessageBg"
				: call.status === undefined
					? "toolPendingBg"
					: call.status < 300
						? "toolSuccessBg"
						: "toolErrorBg";
			const bg = (s: string) => this.theme.bg(bgColor, s);
			const box = new Box(1, 0, bg);
			const innerWidth = Math.max(0, width - 2);

			box.addChild(new Text(truncateToWidth(this.summaryLine(call), innerWidth), 0, 0));

			if (this.opts.expanded) {
				for (const line of this.metricsLines(call, innerWidth)) box.addChild(new Text(line, 0, 0));
				if (this.opts.showRaw) {
					box.addChild(new Text(bg(" ".repeat(innerWidth)), 0, 0));
					for (const line of this.rawLines("→ REQUEST", "accent", call.requestPayload, innerWidth)) {
						box.addChild(new Text(line, 0, 0));
					}
					if (call.assistantMessage !== undefined) {
						box.addChild(new Text(bg(" ".repeat(innerWidth)), 0, 0));
						for (const line of this.rawLines("← RESPONSE", "success", call.assistantMessage, innerWidth)) {
							box.addChild(new Text(line, 0, 0));
						}
					}
				}
			}

			container.addChild(box);
		}

		return container.render(width);
	}

	invalidate() {
		// Theme change or forced repaint — drop the cache so build() reruns.
		this.cacheWidth = -1;
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let live: InspectorDetails | null = null;
	// The call awaiting its response/message. A single slot assumes provider calls
	// are strictly sequential (request → response → message, one at a time), which
	// holds for a single agent loop. Concurrent or nested calls (e.g. subagents) would
	// misattribute here and need per-call correlation instead.
	let pending: ApiCall | null = null;
	let isAgentRunning = false;

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const details = message.details as InspectorDetails | undefined;
		const opts: RenderOpts = {
			expanded,
			showRaw: CONFIG.showRaw,
			maxCalls: CONFIG.maxCalls,
			maxStringLen: CONFIG.maxStringLen,
			hidePaths: CONFIG.hidePaths.map(parseHidePath),
			headerFilter: CONFIG.headerFilter,
		};
		return new InspectorComponent(details?.calls ?? [], opts, theme);
	});

	pi.on("input", () => {
		// If the user sends a steering/follow-up message while the agent is running,
		// clear the current inspector so it only shows calls since that new input.
		// Normal new prompts are handled by before_agent_start creating a fresh inspector.
		if (!isAgentRunning) return;
		if (live) {
			live.calls.length = 0;
		}
		pending = null;
	});

	pi.on("before_agent_start", () => {
		live = { calls: [] };
		pending = null;
		return {
			message: { customType: CUSTOM_TYPE, content: "", display: true, details: live },
		};
	});

	pi.on("agent_start", () => {
		isAgentRunning = true;
	});

	pi.on("agent_end", () => {
		isAgentRunning = false;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as { model?: string } | undefined;
		const api = ctx.model?.api ?? "unknown";
		const call: ApiCall = {
			provider: ctx.model?.provider ?? "unknown",
			model: ctx.model?.id ?? payload?.model ?? "unknown",
			url: joinUrl(ctx.model?.baseUrl ?? "unknown", getApiEndpoint(api)),
			requestPayload: event.payload,
			requestAt: Date.now(),
		};
		pending = call;
		live?.calls.push(call);
	});

	pi.on("after_provider_response", (event) => {
		if (!pending) return;
		pending.status = event.status;
		pending.headers = event.headers;
		pending.responseAt = Date.now();
	});

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessageLike | undefined;
		if (message?.role !== "assistant" || !pending) return;
		pending.usage = message.usage;
		pending.responseId = message.responseId;
		pending.responseModel = message.responseModel;
		pending.stopReason = message.stopReason;
		pending.assistantMessage = event.message;
		pending.messageAt = Date.now();
		pending = null;
	});

	// Keep the inspector panels out of the LLM context.
	pi.on("context", (event) => ({
		messages: event.messages.filter((m) => {
			if (m.role !== "custom") return true;
			return (m as { customType?: string }).customType !== CUSTOM_TYPE;
		}),
	}));

	pi.on("session_shutdown", () => {
		live = null;
		pending = null;
		isAgentRunning = false;
	});
}
