/** TrajectoryRecord — unified record model. Both LiveSource and replay backfill emit these. */

/** Provider-neutral usage persisted by Pi. Keep every known Pi field for inspection. */
export interface UsageCostInfo {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface UsageInfo {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Anthropic 1-hour cache-write subset; included in cacheWrite. */
	cacheWrite1h?: number;
	/** Provider-reported reasoning tokens; included in output. */
	reasoning?: number;
	totalTokens?: number;
	cost?: UsageCostInfo;
}

/**
 * Non-owning references used by the inspector. Historical entries are objects
 * returned by the readonly SessionManager; live values are terminal event
 * objects. They deliberately are not deep-cloned on streaming updates.
 */
export interface InspectorSource {
	source: "history" | "live";
	entryId?: string;
	entryType?: string;
	/** entry.timestamp (JSONL persistence time), converted to Unix ms when valid. */
	entryTimestamp?: number;
	/** message.timestamp, if this record originated from a message. */
	messageTimestamp?: number;
	rawEntry?: unknown;
	rawMessage?: unknown;
}

export type MarkerKind = "model_change" | "thinking_change" | "branch" | "bash" | "custom" | "unknown" | "note";

export interface BaseRecord {
	/** Stable record id (session entry id plus a suffix for derived tool rows, or generated live id). */
	id: string;
	/**
	 * Unix ms used to order/display the trace. For history this is normally
	 * entry.timestamp (persistence time); for live it is the observed event time.
	 */
	ts: number;
	/** Session entry id when persisted; derived tool rows retain their parent entry id. */
	entryId?: string;
	/** Inspector-safe, non-owning source reference and timestamp metadata. */
	inspector?: InspectorSource;
	/** Owning turn index (1-based). Turn increments on each user record. */
	turn: number;
}

export interface UserRecord extends BaseRecord {
	kind: "user";
	text: string;
	imageCount: number;
	/** Original string or content-block array, retained by reference for the inspector. */
	content?: unknown;
}

export interface AssistantRecord extends BaseRecord {
	kind: "assistant";
	text: string;
	thinkingText?: string;
	/** Original ordered content-block array, retained by reference for the inspector. */
	content?: unknown;
	api?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	responseId?: string;
	usage?: UsageInfo;
	stopReason?: string;
	rawStopReason?: string;
	errorMessage?: string;
	diagnostics?: unknown;
	/** live only: message_start → first message_update. Never reconstructed from history. */
	ttftMs?: number;
	/** live only: first message_update → message_end. Never reconstructed from history. */
	decodeMs?: number;
	/**
	 * Historical display-only estimated window start: previous persisted entry.
	 * It is not an LLM start timestamp and must never be labelled TTFT/decode.
	 */
	startTs?: number;
	streaming?: boolean;
	interrupted?: boolean;
}

export type ToolStatus = "running" | "ok" | "error" | "interrupted";

export interface ToolResultInfo {
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Original ordered tool-result content blocks, retained by reference. */
	content?: unknown;
	details?: unknown;
	usage?: UsageInfo;
	addedToolNames?: string[];
	/** The persisted result entry or terminal live result; no deep copy. */
	raw?: unknown;
	entryId?: string;
	entryTimestamp?: number;
	messageTimestamp?: number;
}

export interface ToolRecord extends BaseRecord {
	kind: "tool";
	toolCallId: string;
	name: string;
	/** One-line preview of args (path, command, …). */
	argsSummary: string;
	/** Full provider-neutral tool arguments, retained by reference. */
	args?: unknown;
	namespace?: string;
	status: ToolStatus;
	output?: string;
	durationMs?: number;
	result?: ToolResultInfo;
}

export interface CompactionRecord extends BaseRecord {
	kind: "compaction";
	summary: string;
	tokensBefore?: number;
	usage?: UsageInfo;
	details?: unknown;
}

export interface MarkerRecord extends BaseRecord {
	kind: "marker";
	marker: MarkerKind;
	text: string;
	detail?: string;
	usage?: UsageInfo;
	details?: unknown;
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
	const s = Math.round((ms - m * 60_000) / 1000);
	if (s === 60) return `${m + 1}m0s`; // 1m59.6s rounds up, not "1m60s"
	return `${m}m${s}s`;
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
