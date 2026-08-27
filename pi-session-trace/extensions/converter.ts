/** EntryConverter — incremental pi session-entry → TrajectoryRecord conversion.
 *
 * Shared by the live backfill (sessionManager.getEntries()) and by dev scripts
 * that feed JSONL lines. The session file itself is pi's persistence layer;
 * historical viewing goes through pi's native /resume + backfill.
 */

import type { ToolRecord, TrajectoryRecord } from "./types.ts";

/** Incremental entry → record converter (one push() per session entry). */
export class EntryConverter {
	private turn = 0;
	private counter = 0;
	/** Latest event timestamp seen — used to approximate assistant span starts. */
	private lastEventTs = 0;
	/** toolCallId → pending ToolRecord awaiting its toolResult. */
	private pendingTools = new Map<string, ToolRecord>();

	get lastTurn(): number {
		return this.turn;
	}

	/** Tool call ids still waiting for a result (for live-mode correlation). */
	pendingToolIds(): Map<string, string> {
		// toolCallId → record id
		const out = new Map<string, string>();
		for (const [callId, rec] of this.pendingTools) out.set(callId, rec.id);
		return out;
	}

	/** Convert one session entry; returns produced records (may be empty). */
	push(entry: any): TrajectoryRecord[] {
		const out: TrajectoryRecord[] = [];
		const ts = Date.parse(entry.timestamp ?? "") || 0;
		const id = typeof entry.id === "string" ? entry.id : `gen-${this.counter++}`;
		const prevTs = this.lastEventTs;
		if (ts > 0) this.lastEventTs = Math.max(this.lastEventTs, ts);

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				if (!msg) break;
				if (msg.role === "user") {
					this.turn++;
					out.push({
						kind: "user",
						id,
						ts,
						turn: this.turn,
						text: extractText(msg.content),
						imageCount: countImages(msg.content),
					});
				} else if (msg.role === "assistant") {
					out.push({
						kind: "assistant",
						id,
						ts,
						turn: this.turn,
						text: extractText(msg.content),
						thinkingText: extractThinking(msg.content) || undefined,
						model: msg.model,
						usage: msg.usage,
						stopReason: msg.stopReason,
						interrupted: msg.stopReason === "aborted" || msg.stopReason === "error",
						// Approximate span: LLM call started right after the previous event.
						startTs: prevTs > 0 && prevTs < ts ? prevTs : undefined,
					});
					for (const call of extractToolCalls(msg.content)) {
						const rec: ToolRecord = {
							kind: "tool",
							id: `${id}:${call.id}`,
							ts,
							turn: this.turn,
							toolCallId: call.id,
							name: call.name,
							argsSummary: summarizeArgs(call.name, call.args),
							args: call.args,
							status: "running",
						};
						this.pendingTools.set(call.id, rec);
						out.push(rec);
					}
				} else if (msg.role === "toolResult") {
					const callId = msg.toolCallId ?? "";
					const output = extractText(msg.content);
					const pending = this.pendingTools.get(callId);
					if (pending) {
						pending.status = msg.isError ? "error" : "ok";
						pending.output = output;
						pending.durationMs = ts - pending.ts;
						this.pendingTools.delete(callId);
					} else {
						// Result whose call isn't visible (e.g. pre-compaction) — show completed.
						out.push({
							kind: "tool",
							id: `${id}:result`,
							ts,
							turn: this.turn,
							toolCallId: callId,
							name: msg.toolName ?? "tool",
							argsSummary: "",
							status: msg.isError ? "error" : "ok",
							output,
						});
					}
				} else if (msg.role === "bashExecution") {
					const exit = msg.exitCode === undefined ? "…" : String(msg.exitCode);
					out.push({
						kind: "marker",
						id,
						ts,
						turn: this.turn,
						marker: "bash",
						text: `$ ${msg.command ?? ""}`,
						detail: `exit ${exit}${msg.cancelled ? " (cancelled)" : ""}\n${msg.output ?? ""}`.trim(),
					});
				} else if (msg.role === "custom") {
					if (msg.display) {
						out.push({
							kind: "marker",
							id,
							ts,
							turn: this.turn,
							marker: "custom",
							text: `[${msg.customType ?? "custom"}]`,
							detail: extractText(msg.content),
						});
					}
				}
				// compactionSummary / branchSummary messages mirror the dedicated
				// compaction / branch_summary entries — skip to avoid duplicates.
				break;
			}
			case "compaction":
				out.push({
					kind: "compaction",
					id,
					ts,
					turn: this.turn,
					summary: entry.summary ?? "",
					tokensBefore: entry.tokensBefore,
				});
				break;
			case "model_change":
				out.push({
					kind: "marker",
					id,
					ts,
					turn: this.turn,
					marker: "model_change",
					text: `model → ${entry.provider ?? "?"}/${entry.modelId ?? "?"}`,
				});
				break;
			case "thinking_level_change":
				out.push({
					kind: "marker",
					id,
					ts,
					turn: this.turn,
					marker: "thinking_change",
					text: `thinking → ${entry.thinkingLevel ?? "?"}`,
				});
				break;
			case "branch_summary":
				out.push({
					kind: "marker",
					id,
					ts,
					turn: this.turn,
					marker: "branch",
					text: "branch point",
					detail: entry.summary,
				});
				break;
			default:
				break; // session header, custom entries, … — nothing to show
		}
		return out;
	}

	/** Mark still-pending tools as interrupted (session ended mid-flight). */
	finalize(): void {
		for (const rec of this.pendingTools.values()) rec.status = "interrupted";
	}
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
	if (!Array.isArray(content)) return 0;
	return content.filter((b) => b?.type === "image").length;
}

function extractToolCalls(content: unknown): { id: string; name: string; args: unknown }[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b?.type === "toolCall")
		.map((b) => ({ id: String(b.id ?? ""), name: String(b.name ?? "tool"), args: b.arguments }));
}

function summarizeArgs(name: string, args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	// Common pi tool arg shapes — pick the most identifying field.
	for (const key of ["path", "file", "command", "query", "url", "pattern"]) {
		if (typeof a[key] === "string") return oneLine(a[key] as string, 80);
	}
	const json = JSON.stringify(args);
	return oneLine(json ?? "", 80);
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
