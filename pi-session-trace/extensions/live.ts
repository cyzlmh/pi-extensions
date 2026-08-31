/** LiveSource — subscribe to Pi lifecycle events and keep a TraceStore current. */

import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionCompactEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { EntryConverter } from "./converter.ts";
import type { TraceStore } from "./store.ts";
import type { InspectorSource, ToolResultInfo, TrajectoryRecord, UsageInfo } from "./types.ts";

/**
 * Collection starts at extension load (not when /trace first runs), so the
 * view is complete whenever opened. On session_start we replay only the
 * active root→leaf path returned by sessionManager.getBranch(). /resume remains
 * Pi's job; switching it triggers this fresh, read-only backfill.
 */
export class LiveSource {
	private converter = new EntryConverter();
	private turn = 0;
	private seq = 0;
	/** toolCallId → record id, seeded from backfill so late results still correlate. */
	private toolRecordIds = new Map<string, string>();
	/** The one assistant message currently streaming (Pi streams ≤1 per turn). */
	private openAssistant: { recordId: string; startMs: number; firstUpdateMs?: number } | undefined;

	constructor(private store: TraceStore) {}

	attach(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => this.backfill(ctx));
		pi.on("message_start", (e) => this.onMessageStart(e));
		pi.on("message_update", (e) => this.onMessageUpdate(e));
		pi.on("message_end", (e) => this.onMessageEnd(e));
		pi.on("tool_execution_start", (e) => this.onToolStart(e));
		pi.on("tool_execution_update", (e) => this.onToolUpdate(e));
		pi.on("tool_execution_end", (e) => this.onToolEnd(e));
		pi.on("session_compact", (e) => this.onCompact(e));
		pi.on("model_select", (e) => {
			this.push({
				kind: "marker",
				turn: this.turn,
				marker: "model_change",
				text: `model → ${e.model.provider}/${e.model.id}`,
				inspector: liveInspector("model_select", e),
			});
		});
		pi.on("thinking_level_select", (e) => {
			this.push({
				kind: "marker",
				turn: this.turn,
				marker: "thinking_change",
				text: `thinking → ${e.level}`,
				inspector: liveInspector("thinking_level_select", e),
			});
		});
	}

	/** Fill the store from the selected session branch already held by Pi. */
	private backfill(ctx: ExtensionContext): void {
		// session_start fires on every session switch (startup/resume/new/fork/reload)
		// — reset everything or the previous session's records/state bleed through.
		this.converter = new EntryConverter();
		this.toolRecordIds.clear();
		this.openAssistant = undefined;
		this.store.reset();
		const records: TrajectoryRecord[] = [];
		for (const entry of currentBranchEntries(ctx)) records.push(...this.converter.push(entry));
		for (const [callId, recId] of this.converter.pendingToolIds()) this.toolRecordIds.set(callId, recId);
		this.turn = this.converter.lastTurn;
		this.store.appendMany(records);
	}

	// ---------------------------------------------------------------- messages

	private onMessageStart(e: MessageStartEvent): void {
		const msg = e.message as any;
		const now = Date.now();
		if (msg.role === "user") {
			this.turn++;
			this.push({
				kind: "user",
				turn: this.turn,
				text: extractText(msg.content),
				imageCount: Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "image").length : 0,
				content: msg.content,
				inspector: liveInspector("message", msg, msg),
			});
			return;
		}
		if (msg.role !== "assistant") return;
		const recordId = this.push({
			kind: "assistant",
			turn: this.turn,
			text: extractText(msg.content),
			thinkingText: extractThinking(msg.content) || undefined,
			content: msg.content,
			api: stringOrUndefined(msg.api),
			provider: stringOrUndefined(msg.provider),
			model: stringOrUndefined(msg.model),
			streaming: true,
			inspector: liveInspector("message", msg, msg),
		});
		this.openAssistant = { recordId, startMs: now };
	}

	private onMessageUpdate(e: MessageUpdateEvent): void {
		if (!this.openAssistant) return;
		const msg = e.message as any;
		if (msg.role !== "assistant") return;
		if (this.openAssistant.firstUpdateMs === undefined) this.openAssistant.firstUpdateMs = Date.now();
		// Only replace small record fields/wrappers here. content and rawMessage are
		// direct references, so token streaming never deep-copies a large message.
		this.store.update(this.openAssistant.recordId, {
			text: extractText(msg.content),
			thinkingText: extractThinking(msg.content) || undefined,
			content: msg.content,
			api: stringOrUndefined(msg.api),
			provider: stringOrUndefined(msg.provider),
			model: stringOrUndefined(msg.model),
			inspector: liveInspector("message", msg, msg),
		});
	}

	private onMessageEnd(e: MessageEndEvent): void {
		const msg = e.message as any;
		if (msg.role !== "assistant" || !this.openAssistant) return;
		const { recordId, startMs, firstUpdateMs } = this.openAssistant;
		this.openAssistant = undefined;
		const now = Date.now();
		this.store.update(recordId, {
			text: extractText(msg.content),
			thinkingText: extractThinking(msg.content) || undefined,
			content: msg.content,
			api: stringOrUndefined(msg.api),
			provider: stringOrUndefined(msg.provider),
			model: stringOrUndefined(msg.model),
			responseModel: stringOrUndefined(msg.responseModel),
			responseId: stringOrUndefined(msg.responseId),
			usage: asUsage(msg.usage),
			stopReason: stringOrUndefined(msg.stopReason),
			rawStopReason: stringOrUndefined(msg.rawStopReason),
			errorMessage: stringOrUndefined(msg.errorMessage),
			diagnostics: msg.diagnostics,
			interrupted: msg.stopReason === "aborted" || msg.stopReason === "error",
			streaming: false,
			// These measurements exist only while this extension watches the live
			// lifecycle; persisted history cannot recreate them.
			ttftMs: firstUpdateMs !== undefined ? firstUpdateMs - startMs : undefined,
			decodeMs: firstUpdateMs !== undefined ? now - firstUpdateMs : undefined,
			inspector: liveInspector("message", msg, msg),
		});
	}

	// ------------------------------------------------------------------ tools

	private onToolStart(e: ToolExecutionStartEvent): void {
		const recordId = this.push({
			kind: "tool",
			turn: this.turn,
			toolCallId: e.toolCallId,
			name: e.toolName,
			argsSummary: summarizeArgs(e.args),
			args: e.args,
			namespace: stringOrUndefined((e as any).namespace),
			status: "running",
			inspector: liveInspector("tool_execution_start", e),
		});
		this.toolRecordIds.set(e.toolCallId, recordId);
	}

	private onToolUpdate(e: ToolExecutionUpdateEvent): void {
		const recordId = this.toolRecordIds.get(e.toolCallId);
		if (!recordId) return;
		const partial = extractText((e.partialResult as any)?.content);
		if (partial) this.store.update(recordId, { output: partial });
	}

	private onToolEnd(e: ToolExecutionEndEvent): void {
		const recordId = this.toolRecordIds.get(e.toolCallId);
		if (!recordId) return;
		this.toolRecordIds.delete(e.toolCallId);
		const rec = this.store.get(recordId);
		const result = e.result as any;
		const output = extractText(result?.content) || "";
		this.store.update(recordId, {
			status: e.isError ? "error" : "ok",
			output,
			durationMs: rec ? Date.now() - rec.ts : undefined,
			result: liveToolResult(result, e),
			inspector: liveInspector("tool_execution_end", e, result),
		});
	}

	private onCompact(e: SessionCompactEvent): void {
		const records = this.converter.push(e.compactionEntry);
		// converter's turn counter is replay-oriented; live turn authority is ours
		for (const r of records) r.turn = this.turn;
		this.store.appendMany(records);
	}

	// ------------------------------------------------------------------ emit

	private push(partial: DistributiveOmit<TrajectoryRecord, "id" | "ts">): string {
		const id = `live-${this.seq++}`;
		this.store.appendMany([{ ...partial, id, ts: Date.now() } as TrajectoryRecord]);
		return id;
	}
}

// ---------------------------------------------------------------------------
// Current-branch compatibility helper

type CompatibleSessionManager = {
	getBranch?: () => unknown;
	getEntries?: () => unknown;
	getLeafId?: () => unknown;
};

type TreeEntry = { id?: unknown; parentId?: unknown };

/**
 * Prefer the public getBranch() API. If an older compatible host lacks it,
 * reconstruct only the root→current-leaf parent chain from getEntries()+
 * getLeafId(). If no leaf is available, return no history rather than mixing
 * every branch into the default trace.
 */
function currentBranchEntries(ctx: ExtensionContext): unknown[] {
	const manager = ctx.sessionManager as CompatibleSessionManager;
	if (typeof manager.getBranch === "function") {
		try {
			const branch = manager.getBranch();
			if (Array.isArray(branch)) return branch;
		} catch {
			// Fall through to the parent-chain reconstruction below.
		}
	}
	if (typeof manager.getEntries !== "function" || typeof manager.getLeafId !== "function") return [];
	try {
		const entries = manager.getEntries();
		const leafId = manager.getLeafId();
		if (!Array.isArray(entries) || typeof leafId !== "string") return [];
		const byId = new Map<string, unknown>();
		for (const entry of entries) if (isObject(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
		const branch: unknown[] = [];
		const visited = new Set<string>();
		let currentId: string | undefined = leafId;
		while (currentId && !visited.has(currentId)) {
			visited.add(currentId);
			const entry = byId.get(currentId) as TreeEntry | undefined;
			if (!entry) return [];
			branch.push(entry);
			currentId = typeof entry.parentId === "string" ? entry.parentId : undefined;
		}
		return currentId === undefined ? branch.reverse() : [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// content helpers (message objects, not session entries)

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

function liveInspector(entryType: string, rawEntry: unknown, rawMessage?: unknown): InspectorSource {
	const messageTimestamp = isObject(rawMessage) && typeof rawMessage.timestamp === "number" ? rawMessage.timestamp : undefined;
	return { source: "live", entryType, messageTimestamp, rawEntry, rawMessage };
}

function liveToolResult(result: any, event: ToolExecutionEndEvent): ToolResultInfo {
	return {
		toolCallId: stringOrUndefined(result?.toolCallId) ?? event.toolCallId,
		toolName: stringOrUndefined(result?.toolName),
		isError: typeof result?.isError === "boolean" ? result.isError : event.isError,
		content: result?.content,
		details: result?.details,
		usage: asUsage(result?.usage),
		addedToolNames: Array.isArray(result?.addedToolNames)
			? result.addedToolNames.filter((name: unknown): name is string => typeof name === "string")
			: undefined,
		raw: result,
		messageTimestamp: typeof result?.timestamp === "number" ? result.timestamp : undefined,
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" || b?.type === "toolResult")
		.map((b: any) => (typeof b.text === "string" ? b.text : ""))
		.filter(Boolean)
		.join("\n");
}

function extractThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "thinking")
		.map((b: any) => (typeof b.thinking === "string" ? b.thinking : ""))
		.filter(Boolean)
		.join("\n");
}

function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["path", "file", "command", "query", "url", "pattern"]) {
		if (typeof a[key] === "string") return oneLine(a[key], 80);
	}
	return oneLine(stringify(args), 80);
}

function asUsage(value: unknown): UsageInfo | undefined {
	return isObject(value) ? (value as UsageInfo) : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function stringify(v: unknown): string {
	try {
		return JSON.stringify(v) ?? "";
	} catch {
		return "[unserializable arguments]";
	}
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
