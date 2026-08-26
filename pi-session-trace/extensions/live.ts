/** LiveSource — subscribe to pi lifecycle events and keep a TraceStore current. */

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
import { EntryConverter } from "./replay.ts";
import type { TraceStore } from "./store.ts";
import type { TrajectoryRecord } from "./types.ts";

/**
 * Collection starts at extension load (not when /trace first runs), so the
 * view is complete whenever opened. On session_start we backfill from
 * sessionManager.getEntries() — resume/fork/reload thus show full history
 * and live events continue seamlessly from there.
 */
export class LiveSource {
	private converter = new EntryConverter();
	private turn = 0;
	private seq = 0;
	/** toolCallId → record id, seeded from backfill so late results still correlate. */
	private toolRecordIds = new Map<string, string>();
	/** The one assistant message currently streaming (pi streams ≤1 per turn). */
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
			this.push({ kind: "marker", turn: this.turn, marker: "model_change", text: `model → ${e.model.provider}/${e.model.id}` });
		});
		pi.on("thinking_level_select", (e) => {
			this.push({ kind: "marker", turn: this.turn, marker: "thinking_change", text: `thinking → ${e.level}` });
		});
	}

	/** Fill the store from already-persisted session entries (resume/fork/reload). */
	private backfill(ctx: ExtensionContext): void {
		const records: TrajectoryRecord[] = [];
		for (const entry of ctx.sessionManager.getEntries()) records.push(...this.converter.push(entry));
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
			});
			return;
		}
		if (msg.role !== "assistant") return;
		const recordId = this.push({
		kind: "assistant",
			turn: this.turn,
			text: "",
			streaming: true,
		});
		this.openAssistant = { recordId, startMs: now };
	}

	private onMessageUpdate(e: MessageUpdateEvent): void {
		if (!this.openAssistant) return;
		const msg = e.message as any;
		if (msg.role !== "assistant") return;
		if (this.openAssistant.firstUpdateMs === undefined) this.openAssistant.firstUpdateMs = Date.now();
		this.store.update(this.openAssistant.recordId, {
			text: extractText(msg.content),
			thinkingText: extractThinking(msg.content) || undefined,
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
			model: msg.model,
			usage: msg.usage,
			stopReason: msg.stopReason,
			interrupted: msg.stopReason === "aborted" || msg.stopReason === "error",
			streaming: false,
			ttftMs: firstUpdateMs !== undefined ? firstUpdateMs - startMs : undefined,
			decodeMs: firstUpdateMs !== undefined ? now - firstUpdateMs : undefined,
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
			status: "running",
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
		const output = extractText((e.result as any)?.content) || stringify(e.result);
		this.store.update(recordId, {
			status: e.isError ? "error" : "ok",
			output,
			durationMs: rec ? Date.now() - rec.ts : undefined,
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
// content helpers (mirror replay.ts; message objects, not entries)

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
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
		if (typeof a[key] === "string") return oneLine(a[key] as string, 80);
	}
	const json = stringify(args);
	return oneLine(json, 80);
}

function stringify(v: unknown): string {
	try {
		return JSON.stringify(v) ?? "";
	} catch {
		return "";
	}
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
