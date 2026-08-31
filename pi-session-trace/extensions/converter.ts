/** EntryConverter — incremental Pi session-entry → TrajectoryRecord conversion.
 *
 * Historical records preserve non-owning references to the SessionManager entry
 * and its message/content objects. This makes the inspector low-loss without
 * copying large images, tool outputs, or streamed content into another store.
 */

import type { InspectorSource, ToolRecord, ToolResultInfo, TrajectoryRecord, UsageInfo } from "./types.ts";

/** Incremental entry → record converter (one push() per session entry). */
export class EntryConverter {
	private turn = 0;
	private counter = 0;
	/** Latest persisted entry timestamp; used only as a historical estimated-window boundary. */
	private lastEventTs = 0;
	/** toolCallId → pending ToolRecord awaiting its toolResult. */
	private pendingTools = new Map<string, ToolRecord>();

	get lastTurn(): number {
		return this.turn;
	}

	/** Tool call ids still waiting for a result (for live-mode correlation). */
	pendingToolIds(): Map<string, string> {
		const out = new Map<string, string>();
		for (const [callId, rec] of this.pendingTools) out.set(callId, rec.id);
		return out;
	}

	/** Convert one persisted session entry; returns produced records (may be empty). */
	push(entry: any): TrajectoryRecord[] {
		const out: TrajectoryRecord[] = [];
		const ts = parseTimestamp(entry?.timestamp);
		const entryId = typeof entry?.id === "string" ? entry.id : undefined;
		const id = entryId ?? `gen-${this.counter++}`;
		const prevTs = this.lastEventTs;
		// A session header (not returned by getEntries/getBranch) is metadata rather
		// than a trajectory event. Do not let its resume-time timestamp contaminate
		// the historical estimated window.
		if (ts > 0 && entry?.type !== "session") this.lastEventTs = Math.max(this.lastEventTs, ts);
		const inspector = historyInspector(entry, entry?.message, entryId, ts);

		switch (entry?.type) {
			case "session":
				break;
			case "message": {
				const msg = entry.message;
				if (!msg) {
					out.push(this.unknownEntry(id, entryId, ts, inspector, "message entry without message"));
					break;
				}
				const messageTimestamp = numericTimestamp(msg.timestamp);
				const messageInspector = { ...inspector, messageTimestamp, rawMessage: msg };
				if (msg.role === "user") {
					this.turn++;
					out.push({
						kind: "user",
						id,
						entryId,
						ts,
						turn: this.turn,
						text: extractText(msg.content),
						imageCount: countImages(msg.content),
						content: msg.content,
						inspector: messageInspector,
					});
				} else if (msg.role === "assistant") {
					out.push({
						kind: "assistant",
						id,
						entryId,
						ts,
						turn: this.turn,
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
						// This is only a visual historical window. It is deliberately not
						// treated as the LLM's start or as a recoverable timing metric.
						startTs: prevTs > 0 && prevTs < ts ? prevTs : undefined,
						inspector: messageInspector,
					});
					for (const call of extractToolCalls(msg.content)) {
						const rec: ToolRecord = {
							kind: "tool",
							id: `${id}:${call.id}`,
							entryId,
							ts,
							turn: this.turn,
							toolCallId: call.id,
							name: call.name,
							argsSummary: summarizeArgs(call.args),
							args: call.args,
							namespace: call.namespace,
							status: "running",
							inspector: messageInspector,
						};
						this.pendingTools.set(call.id, rec);
						out.push(rec);
					}
				} else if (msg.role === "toolResult") {
					const callId = String(msg.toolCallId ?? "");
					const output = extractText(msg.content);
					const result = toolResultInfo(msg, entry, entryId, ts, messageTimestamp);
					const pending = this.pendingTools.get(callId);
					if (pending) {
						pending.status = msg.isError ? "error" : "ok";
						pending.output = output;
						pending.result = result;
						pending.durationMs = ts > 0 && pending.ts > 0 ? Math.max(0, ts - pending.ts) : undefined;
						this.pendingTools.delete(callId);
					} else {
						// Result whose call is not visible (for example a compacted prefix).
						out.push({
							kind: "tool",
							id: `${id}:result`,
							entryId,
							ts,
							turn: this.turn,
							toolCallId: callId,
							name: stringOrUndefined(msg.toolName) ?? "tool",
							argsSummary: "",
							status: msg.isError ? "error" : "ok",
							output,
							result,
							inspector: messageInspector,
						});
					}
				} else if (msg.role === "bashExecution") {
					const exit = msg.exitCode === undefined ? "…" : String(msg.exitCode);
					out.push({
						kind: "marker",
						id,
						entryId,
						ts,
						turn: this.turn,
						marker: "bash",
						text: `$ ${msg.command ?? ""}`,
						detail: `exit ${exit}${msg.cancelled ? " (cancelled)" : ""}\n${msg.output ?? ""}`.trim(),
						inspector: messageInspector,
					});
				} else if (msg.role === "custom") {
					// Keep non-displayed custom messages inspectable as well; hiding them
					// would make a persisted semantic event disappear from the trace.
					out.push({
						kind: "marker",
						id,
						entryId,
						ts,
						turn: this.turn,
						marker: "custom",
						text: `[${msg.customType ?? "custom"}]${msg.display === false ? " (hidden)" : ""}`,
						detail: extractText(msg.content),
						details: msg.details,
						inspector: messageInspector,
					});
				} else {
					out.push(this.unknownEntry(id, entryId, ts, messageInspector, `unsupported message role: ${String(msg.role ?? "unknown")}`));
				}
				break;
			}
			case "compaction":
				out.push({
					kind: "compaction",
					id,
					entryId,
					ts,
					turn: this.turn,
					summary: typeof entry.summary === "string" ? entry.summary : "",
					tokensBefore: numberOrUndefined(entry.tokensBefore),
					usage: asUsage(entry.usage),
					details: entry.details,
					inspector,
				});
				break;
			case "model_change":
				out.push({
					kind: "marker",
					id,
					entryId,
					ts,
					turn: this.turn,
					marker: "model_change",
					text: `model → ${entry.provider ?? "?"}/${entry.modelId ?? "?"}`,
					inspector,
				});
				break;
			case "thinking_level_change":
				out.push({
					kind: "marker",
					id,
					entryId,
					ts,
					turn: this.turn,
					marker: "thinking_change",
					text: `thinking → ${entry.thinkingLevel ?? "?"}`,
					inspector,
				});
				break;
			case "branch_summary":
				out.push({
					kind: "marker",
					id,
					entryId,
					ts,
					turn: this.turn,
					marker: "branch",
					text: "branch point",
					detail: typeof entry.summary === "string" ? entry.summary : undefined,
					usage: asUsage(entry.usage),
					details: entry.details,
					inspector,
				});
				break;
			case "custom_message":
				out.push({
					kind: "marker",
					id,
					entryId,
					ts,
					turn: this.turn,
					marker: "custom",
					text: `[custom message: ${entry.customType ?? "custom"}]${entry.display === false ? " (hidden)" : ""}`,
					detail: extractText(entry.content),
					details: entry.details,
					inspector,
				});
				break;
			case "custom":
				out.push({
					kind: "marker",
					id,
					entryId,
					ts,
					turn: this.turn,
					marker: "custom",
					text: `[custom entry: ${entry.customType ?? "custom"}]`,
					details: entry.data,
					inspector,
				});
				break;
			default:
				// Labels, session-info, future Pi entries, and malformed input remain
				// visible and have a generic raw JSON inspector instead of vanishing.
				out.push(this.unknownEntry(id, entryId, ts, inspector, `unsupported entry: ${String(entry?.type ?? "unknown")}`));
				break;
		}
		return out;
	}

	/** Mark still-pending tools as interrupted (session ended mid-flight). */
	finalize(): void {
		for (const rec of this.pendingTools.values()) rec.status = "interrupted";
	}

	private unknownEntry(id: string, entryId: string | undefined, ts: number, inspector: InspectorSource, text: string): TrajectoryRecord {
		return { kind: "marker", id, entryId, ts, turn: this.turn, marker: "unknown", text, inspector };
	}
}

function historyInspector(entry: unknown, message: unknown, entryId: string | undefined, entryTimestamp: number): InspectorSource {
	return {
		source: "history",
		entryId,
		entryType: isObject(entry) && typeof entry.type === "string" ? entry.type : undefined,
		entryTimestamp: entryTimestamp || undefined,
		rawEntry: entry,
		rawMessage: message,
	};
}

function toolResultInfo(msg: any, entry: unknown, entryId: string | undefined, entryTimestamp: number, messageTimestamp: number | undefined): ToolResultInfo {
	return {
		toolCallId: stringOrUndefined(msg.toolCallId),
		toolName: stringOrUndefined(msg.toolName),
		isError: typeof msg.isError === "boolean" ? msg.isError : undefined,
		content: msg.content,
		details: msg.details,
		usage: asUsage(msg.usage),
		addedToolNames: Array.isArray(msg.addedToolNames) ? msg.addedToolNames.filter((name: unknown): name is string => typeof name === "string") : undefined,
		raw: entry,
		entryId,
		entryTimestamp: entryTimestamp || undefined,
		messageTimestamp,
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text" || b?.type === "toolResult")
		.map((b) => (typeof b.text === "string" ? b.text : ""))
		.filter(Boolean)
		.join("\n");
}

function extractThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "thinking")
		.map((b) => (typeof b.thinking === "string" ? b.thinking : ""))
		.filter(Boolean)
		.join("\n");
}

function countImages(content: unknown): number {
	return Array.isArray(content) ? content.filter((b) => b?.type === "image").length : 0;
}

function extractToolCalls(content: unknown): { id: string; name: string; args: unknown; namespace?: string }[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b?.type === "toolCall")
		.map((b) => ({
			id: String(b.id ?? ""),
			name: String(b.name ?? "tool"),
			args: b.arguments,
			namespace: stringOrUndefined(b.namespace),
		}));
}

function summarizeArgs(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["path", "file", "command", "query", "url", "pattern"]) {
		if (typeof a[key] === "string") return oneLine(a[key], 80);
	}
	return oneLine(safeStringify(args), 80);
}

function asUsage(value: unknown): UsageInfo | undefined {
	return isObject(value) ? (value as UsageInfo) : undefined;
}

function parseTimestamp(value: unknown): number {
	return typeof value === "string" ? Date.parse(value) || 0 : numericTimestamp(value) ?? 0;
}

function numericTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "[unserializable arguments]";
	}
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
