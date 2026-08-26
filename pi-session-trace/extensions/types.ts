/** TrajectoryRecord — unified record model. Both LiveSource and ReplaySource emit these. */

export interface UsageInfo {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export type MarkerKind = "model_change" | "thinking_change" | "branch" | "bash" | "custom" | "note";

export interface BaseRecord {
	/** Stable id (session entry id, or generated for live). */
	id: string;
	/** Unix ms. */
	ts: number;
	/** Owning turn index (1-based). Turn increments on each user record. */
	turn: number;
}

export interface UserRecord extends BaseRecord {
	kind: "user";
	text: string;
	imageCount: number;
}

export interface AssistantRecord extends BaseRecord {
	kind: "assistant";
	text: string;
	thinkingText?: string;
	model?: string;
	usage?: UsageInfo;
	stopReason?: string;
	/** live only: message_start → first message_update. */
	ttftMs?: number;
	/** live only: first message_update → message_end. */
	decodeMs?: number;
	streaming?: boolean;
	interrupted?: boolean;
}

export type ToolStatus = "running" | "ok" | "error" | "interrupted";

export interface ToolRecord extends BaseRecord {
	kind: "tool";
	toolCallId: string;
	name: string;
	/** One-line preview of args (path, command, …). */
	argsSummary: string;
	args?: unknown;
	status: ToolStatus;
	output?: string;
	durationMs?: number;
}

export interface CompactionRecord extends BaseRecord {
	kind: "compaction";
	summary: string;
	tokensBefore?: number;
}

export interface MarkerRecord extends BaseRecord {
	kind: "marker";
	marker: MarkerKind;
	text: string;
	detail?: string;
}

export type TrajectoryRecord = UserRecord | AssistantRecord | ToolRecord | CompactionRecord | MarkerRecord;

export function formatTokens(n: number | undefined): string {
	if (n === undefined) return "-";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "-";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	return `${m}m${Math.round((ms - m * 60_000) / 1000)}s`;
}

export function formatClock(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatRelative(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}
