/** ReplaySource — stream-parse pi session JSONL into TrajectoryRecords. */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { ToolRecord, TrajectoryRecord } from "./types.ts";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

export interface SessionInfo {
	file: string;
	sessionId: string;
	cwd: string;
	project: string;
	createdMs: number;
	mtimeMs: number;
	preview: string;
}

/** List all sessions, newest first. Reads only the head of each file (header + first user msg). */
export async function listSessions(): Promise<SessionInfo[]> {
	const out: SessionInfo[] = [];
	let projectDirs: string[] = [];
	try {
		projectDirs = await readdir(SESSIONS_ROOT);
	} catch {
		return [];
	}
	for (const dir of projectDirs) {
		const dirPath = join(SESSIONS_ROOT, dir);
		let files: string[] = [];
		try {
			files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = join(dirPath, f);
			try {
				const info = await readSessionHead(file);
				if (info) out.push(info);
			} catch {
				// unreadable session file — skip, picker stays robust (E6)
			}
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

async function readSessionHead(file: string): Promise<SessionInfo | undefined> {
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	let sessionId = basename(file, ".jsonl");
	let cwd = "";
	let createdMs = 0;
	let preview = "";
	try {
		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "session") {
				sessionId = entry.id ?? sessionId;
				cwd = entry.cwd ?? "";
				createdMs = Date.parse(entry.timestamp ?? "") || 0;
			} else if (entry.type === "message" && entry.message?.role === "user") {
				preview = extractText(entry.message.content).replace(/\s+/g, " ").slice(0, 120);
				break; // got everything we need
			}
		}
	} finally {
		rl.close();
	}
	if (!createdMs) return undefined;
	const st = await stat(file);
	return {
		file,
		sessionId,
		cwd,
		project: cwd ? basename(cwd) : dirNameToProject(basename(file)),
		createdMs,
		mtimeMs: st.mtimeMs,
		preview: preview || "(no user message)",
	};
}

function dirNameToProject(dirName: string): string {
	// --Users-yzchen-project-- → project (best-effort; cwd from header is authoritative)
	const stripped = dirName.replace(/^--?|--?$/g, "");
	const parts = stripped.split("-").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1]! : dirName;
}

export interface ReplayResult {
	badLines: number;
	recordCount: number;
}

/**
 * Incremental entry → record converter. Shared by streamSession (JSONL lines)
 * and the live backfill (sessionManager.getEntries()) — same session format.
 */
export class EntryConverter {
	private turn = 0;
	private counter = 0;
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

/**
 * Stream-parse a session file, emitting record batches as they are produced
 * so the UI can render progressively (E1/E2).
 *
 * Note: entries are rendered in file order. pi session files are a tree
 * (id/parentId); following the leaf branch is future work (FR-13).
 */
export async function streamSession(
	file: string,
	emit: (batch: TrajectoryRecord[]) => void,
): Promise<ReplayResult> {
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	const converter = new EntryConverter();
	let badLines = 0;
	let recordCount = 0;
	let batch: TrajectoryRecord[] = [];

	const flush = () => {
		if (batch.length === 0) return;
		emit(batch);
		recordCount += batch.length;
		batch = [];
	};

	for await (const line of rl) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			badLines++;
			continue;
		}
		batch.push(...converter.push(entry));
		if (batch.length >= 64) flush();
	}
	converter.finalize();
	flush();
	return { badLines, recordCount };
}

// ---------------------------------------------------------------------------
// content helpers (pi message content: string | ContentBlock[])

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
