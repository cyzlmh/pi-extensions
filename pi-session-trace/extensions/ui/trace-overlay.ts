/** TraceOverlay — main trajectory view: turn-grouped record list + inspector + timeline. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { TraceStore } from "../store.ts";
import {
	type AssistantRecord,
	formatClock,
	formatDuration,
	formatTokens,
	type ToolRecord,
	type TrajectoryRecord,
	type UsageInfo,
} from "../types.ts";

type Row = { type: "header"; turn: number } | { type: "record"; index: number };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const OPEN_ANIM_MS = 120;
const TOOL_COLORS = ["syntaxFunction", "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxType", "accent", "success"] as const satisfies readonly Parameters<Theme["fg"]>[0][];

export class TraceOverlay implements Component {
	private rows: Row[] = [];
	private selected = 0;
	private scroll = 0;
	private collapsed = new Set<number>();
	private inspector: { record: TrajectoryRecord; scroll: number; expanded: boolean; showRaw: boolean } | null = null;
	private note = "";
	/** Tail-following (E1): true until the user scrolls away from the bottom. */
	private follow = true;
	private renderScheduled = false;
	private spinnerIdx = 0;
	private animTimer: ReturnType<typeof setTimeout> | undefined;
	/** Search: / enters input mode, n/N jumps between matches. */
	private searchMode = false;
	private query = "";
	private matchesDirty = true;
	private matches: number[] = [];
	private openedAt = Date.now();
	private unsub: () => void;
	private projection: {
		version: number;
		map: Map<TrajectoryRecord, { s: number; e: number }>;
		start: number;
		end: number;
	} | null = null;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private store: TraceStore,
		private title: string,
		private done: () => void,
	) {
		this.rebuildRows();
		this.unsub = this.store.subscribe(() => {
			this.rebuildRows();
			this.matchesDirty = true;
			if (this.follow) this.selected = Math.max(0, this.rows.length - 1);
			this.scheduleRender();
			this.kickAnimation();
		});
	}

	setNote(note: string): void {
		this.note = note;
		this.tui.requestRender();
	}

	/** Coalesce bursts of store updates into ~16ms render ticks (E1). */
	private scheduleRender(): void {
		if (this.renderScheduled) return;
		this.renderScheduled = true;
		setTimeout(() => {
			this.renderScheduled = false;
			this.tui.requestRender();
		}, 16);
	}

	/** Animate in-flight records (spinner) only while something is in flight. */
	private kickAnimation(): void {
		if (this.animTimer !== undefined || !this.hasInFlight()) return;
		this.animTimer = setTimeout(() => {
			this.animTimer = undefined;
			this.spinnerIdx++;
			if (this.hasInFlight()) {
				this.tui.requestRender();
				this.kickAnimation();
			}
		}, 200);
	}

	private hasInFlight(): boolean {
		// Only the tail can contain in-flight records; scan backwards, stop early.
		for (let i = this.store.records.length - 1; i >= 0; i--) {
			const r = this.store.records[i]!;
			if (r.kind === "assistant" && r.streaming) return true;
			if (r.kind === "tool" && r.status === "running") return true;
			if (r.kind === "user") return false; // turns are atomic; nothing in flight before it
		}
		return false;
	}

	// ------------------------------------------------------------------ rows


	/**
	 * Single O(n) pass — records are appended chronologically so turn numbers
	 * are non-decreasing. Called on every store notification (per token while
	 * streaming), so it must stay linear.
	 */
	private rebuildRows(): void {
		const rows: Row[] = [];
		const recs = this.store.records;
		let curTurn = -1;
		for (let i = 0; i < recs.length; i++) {
			const t = recs[i]!.turn;
			if (t !== curTurn) {
				curTurn = t;
				rows.push({ type: "header", turn: t });
			}
			if (!this.collapsed.has(t)) rows.push({ type: "record", index: i });
		}
		this.rows = rows;
		if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
	}

	// ------------------------------------------------------------------ input

	handleInput(data: string): void {
		if (this.searchMode) return this.handleSearchInput(data);
		if (this.inspector) return this.handleInspectorInput(data);

		if (matchesKey(data, "escape") || data === "q") {
			if (this.animTimer !== undefined) clearTimeout(this.animTimer);
			this.unsub(); // stop rebuilding rows on every token after close
			this.done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.move(-1);
		else if (matchesKey(data, "down") || data === "j") this.move(1);
		else if (matchesKey(data, "pageUp")) this.move(-this.fullPageStep());
		else if (matchesKey(data, "pageDown")) this.move(this.fullPageStep());
		else if (matchesKey(data, "ctrl+u")) this.move(-this.halfPageStep());
		else if (matchesKey(data, "ctrl+d")) this.move(this.halfPageStep());
		else if (data === "c" || data === "e") {
			// fold/expand every turn at once — dsh's collapse-all toggle
			const collapse = data === "c";
			this.collapsed.clear();
			if (collapse) for (const row of this.rows) if (row.type === "header") this.collapsed.add(row.turn);
			this.rebuildRows();
		} else if (data === "]") {
			// next turn header
			for (let i = this.selected + 1; i < this.rows.length; i++)
				if (this.rows[i]!.type === "header") {
					this.select(i);
					this.follow = false;
					break;
				}
		} else if (data === "[") {
			for (let i = this.selected - 1; i >= 0; i--)
				if (this.rows[i]!.type === "header") {
					this.select(i);
					this.follow = false;
					break;
				}
		} else if (data === "g") {
			this.select(0);
			this.follow = false;
		} else if (data === "G") {
			this.select(this.rows.length - 1);
			this.follow = true;
		} else if (data === "/") {
			this.searchMode = true;
		} else if (data === "n") {
			this.jumpMatch(1);
		} else if (data === "N") {
			this.jumpMatch(-1);
		} else if (matchesKey(data, "return")) {
			// Enter drills into a record; headers have no separate detail page, so
			// they use the same key to toggle their turn.
			this.activate();
		} else if (matchesKey(data, "space")) {
			// Space consistently changes expansion, never opens a msg/tool inspector.
			// A selected record folds its owning turn, which makes the operation useful
			// without requiring the user to move back to the turn header first.
			this.toggleSelectedTurn();
		}
		this.tui.requestRender();
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.searchMode = false;
			this.query = "";
			this.matches = [];
		} else if (matchesKey(data, "return")) {
			this.searchMode = false;
			this.matchesDirty = true;
			this.jumpMatch(1);
		} else if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.matchesDirty = true;
		} else if (data.length === 1 && data >= " ") {
			this.query += data;
			this.matchesDirty = true;
		}
		this.tui.requestRender();
	}

	private handleInspectorInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			// q/Esc are hierarchical: go back here, close from the trace list.
			this.inspector = null;
		} else if (matchesKey(data, "up") || data === "k") {
			this.inspector!.scroll = Math.max(0, this.inspector!.scroll - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.inspector!.scroll++;
		} else if (matchesKey(data, "pageUp")) {
			this.inspector!.scroll = Math.max(0, this.inspector!.scroll - this.fullPageStep());
		} else if (matchesKey(data, "pageDown")) {
			this.inspector!.scroll += this.fullPageStep();
		} else if (matchesKey(data, "ctrl+u")) {
			this.inspector!.scroll = Math.max(0, this.inspector!.scroll - this.halfPageStep());
		} else if (matchesKey(data, "ctrl+d")) {
			this.inspector!.scroll += this.halfPageStep();
		} else if (data === "g") {
			this.inspector!.scroll = 0;
		} else if (data === "G") {
			// renderInspector clamps this sentinel to the actual final scroll offset.
			this.inspector!.scroll = Number.MAX_SAFE_INTEGER;
		} else if (data === "x") {
			// Expand textual fields only. Images/base64 and signatures stay redacted.
			this.inspector!.expanded = !this.inspector!.expanded;
			this.inspector!.scroll = 0;
		} else if (data === "r") {
			// Raw JSON is useful for diagnostics, but is intentionally not part of
			// the default reading flow.
			this.inspector!.showRaw = !this.inspector!.showRaw;
			this.inspector!.scroll = 0;
		}
		this.tui.requestRender();
	}

	private fullPageStep(): number {
		// The renderer may reserve less chrome in a narrow terminal, which only
		// makes the jump conservatively smaller than one visible page.
		return Math.max(1, (process.stdout.rows ?? 24) - 8);
	}

	private halfPageStep(): number {
		return Math.max(1, Math.floor(this.fullPageStep() / 2));
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
		this.follow = false;
	}

	private select(idx: number): void {
		this.selected = Math.max(0, Math.min(this.rows.length - 1, idx));
	}

	private toggleSelectedTurn(): void {
		const row = this.rows[this.selected];
		if (!row) return;
		const turn = row.type === "header" ? row.turn : this.store.records[row.index]?.turn;
		if (turn === undefined) return;

		const wasCollapsed = this.collapsed.has(turn);
		if (wasCollapsed) this.collapsed.delete(turn);
		else this.collapsed.add(turn);
		this.rebuildRows();

		// If a record just disappeared into its collapsed turn, retain context by
		// placing the cursor on that turn's header rather than its former row index.
		if (!wasCollapsed) {
			const headerIndex = this.rows.findIndex((candidate) => candidate.type === "header" && candidate.turn === turn);
			if (headerIndex >= 0) this.select(headerIndex);
		}
	}

	private activate(): void {
		const row = this.rows[this.selected];
		if (!row) return;
		if (row.type === "header") {
			this.toggleSelectedTurn();
			return;
		}
		const record = this.store.records[row.index];
		if (record) this.inspector = { record, scroll: 0, expanded: false, showRaw: false };
	}

	// ------------------------------------------------------------------ search

	private searchableText(r: TrajectoryRecord): string {
		switch (r.kind) {
			case "user":
				return r.text;
			case "assistant":
				return [r.text, r.thinkingText, r.api, r.provider, r.model, r.responseModel, r.responseId, r.stopReason, r.rawStopReason, r.errorMessage, compactJson(r.usage), compactJson(r.diagnostics)].filter(Boolean).join(" ");
			case "tool":
				return [r.name, r.namespace, r.argsSummary, compactJson(r.args), r.output, r.result?.toolName, r.result?.addedToolNames?.join(" "), compactJson(r.result?.usage), compactJson(r.result?.details)].filter(Boolean).join(" ");
			case "compaction":
				return `${r.summary} ${compactJson(r.usage)} ${compactJson(r.details)}`;
			case "marker":
				return `${r.text} ${r.detail ?? ""} ${compactJson(r.usage)} ${compactJson(r.details)}`;
		}
	}

	private ensureMatches(): void {
		if (!this.matchesDirty) return;
		this.matchesDirty = false;
		const q = this.query.toLowerCase();
		this.matches = [];
		if (!q) return;
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i]!;
			if (row.type !== "record") continue;
			if (this.searchableText(this.store.records[row.index]!).toLowerCase().includes(q)) this.matches.push(i);
		}
	}

	private jumpMatch(direction: 1 | -1): void {
		this.ensureMatches();
		if (this.matches.length === 0) return;
		// nearest match after (or before) the current selection
		const sorted = this.matches;
		let next: number | undefined;
		if (direction === 1) {
			next = sorted.find((m) => m > this.selected) ?? sorted[0];
		} else {
			next = [...sorted].reverse().find((m) => m < this.selected) ?? sorted[sorted.length - 1];
		}
		if (next !== undefined) {
			this.select(next);
			this.follow = false;
		}
	}

	// ------------------------------------------------------------------ projection

	private recordEnd(r: TrajectoryRecord): number {
		if (r.kind === "assistant") {
			if (r.streaming) return Date.now();
			if (r.ttftMs !== undefined) return r.ts + r.ttftMs + (r.decodeMs ?? 0);
			return r.ts; // history: persisted-entry boundary; recordStart may be an estimated window boundary
		}
		if (r.kind === "tool") {
			if (r.status === "running") return Date.now();
			if (r.durationMs !== undefined) return r.ts + r.durationMs;
		}
		return r.ts;
	}

	private recordStart(r: TrajectoryRecord): number {
		if (r.kind === "assistant" && r.startTs !== undefined) return r.startTs;
		return r.ts;
	}

	/**
	 * Port of dsh's deriveTimedTimeline idle compression: scan the union of busy
	 * intervals across all lanes; gaps where NOTHING runs are removed, and every
	 * span shifts left by the accumulated removed idle. Sequential agent work
	 * (assistant → tool → assistant) thus tiles edge-to-edge with no gaps.
	 */
	private ensureProjection(): NonNullable<TraceOverlay["projection"]> {
		const inFlight = this.hasInFlight();
		if (this.projection && this.projection.version === this.store.version && !inFlight) return this.projection;
		const raw = this.store.records.map((r) => ({ r, s: this.recordStart(r), e: this.recordEnd(r) }));
		const map = new Map<TrajectoryRecord, { s: number; e: number }>();
		const sorted = [...raw].sort((a, b) => a.s - b.s || a.e - b.e);
		let removed = 0;
		let coveredUntil: number | null = null;
		for (const x of sorted) {
			if (coveredUntil !== null && x.s > coveredUntil) removed += x.s - coveredUntil;
			map.set(x.r, { s: x.s - removed, e: x.e - removed });
			coveredUntil = coveredUntil === null ? x.e : Math.max(coveredUntil, x.e);
		}
		const proj = [...map.values()];
		const start = proj.length > 0 ? Math.min(...proj.map((p) => p.s)) : 0;
		const end = proj.length > 0 ? Math.max(...proj.map((p) => p.e)) : 0;
		this.projection = { version: this.store.version, map, start, end };
		return this.projection;
	}

	// ------------------------------------------------------------------ render

	invalidate(): void {
		// theme changed — colors are re-read every render, nothing cached
	}

	render(width: number): string[] {
		const termRows = process.stdout.rows ?? 24;
		const narrow = width < 80;
		const showTimeline = !narrow && this.store.records.length > 1;
		const chrome = (showTimeline ? 4 : 0) + 4; // title+sep, sep+hint; timeline = 3 lanes + axis
		const bodyHeight = Math.max(4, termRows - chrome);

		const totalUsage = this.store.totalUsage();
		const totalTokens = totalUsage ? (totalUsage.input ?? 0) + (totalUsage.output ?? 0) : 0;
		const usageSummary = totalUsage
			? ` · ${formatTokens(totalTokens || totalUsage.totalTokens)} tok${totalUsage.cost?.total !== undefined ? ` · $${totalUsage.cost.total.toFixed(4)}` : ""}`
			: "";
		const title =
			this.theme.bold(this.theme.fg("accent", ` trace `)) +
			this.theme.fg("muted", `${this.title} · ${this.store.records.length} records${usageSummary}`);
		const sep = this.theme.fg("borderMuted", "─".repeat(width));
		const hint = this.renderHint();

		// Clamp scroll before both the list and the timeline consume the window.
		if (!this.inspector) {
			if (this.selected < this.scroll) this.scroll = this.selected;
			if (this.selected >= this.scroll + bodyHeight) this.scroll = this.selected - bodyHeight + 1;
		}
		const body = this.inspector ? this.renderInspector(width, bodyHeight) : this.renderList(width, bodyHeight);
		while (body.length < bodyHeight) body.push(""); // pad to full height — the overlay covers the whole screen

		const lines = [title, sep, ...body];
		if (showTimeline) lines.push(...this.renderTimeline(width, bodyHeight));
		lines.push(sep, hint);

		// Open animation: reveal top-to-bottom over ~120ms (FR-15).
		const elapsed = Date.now() - this.openedAt;
		if (elapsed < OPEN_ANIM_MS) {
			const reveal = Math.ceil((elapsed / OPEN_ANIM_MS) * lines.length);
			setTimeout(() => this.tui.requestRender(), 24);
			return lines.slice(0, Math.max(2, reveal)).map((l) => truncateToWidth(l, width));
		}
		return lines.map((l) => truncateToWidth(l, width));
	}

	private renderHint(): string {
		if (this.searchMode) return this.theme.fg("text", ` /${this.query}`) + this.theme.fg("muted", "█");
		if (this.inspector)
			return this.theme.fg(
				"muted",
				` j/k move · pgUp/pgDn page · ^u/^d half page · g/G top/end · x ${this.inspector.expanded ? "collapse long text" : "expand long text"} · r ${this.inspector.showRaw ? "hide raw" : "raw JSON"} · esc back`,
			);
		let hint = this.theme.fg(
			"muted",
			" j/k move · pgUp/pgDn page · ^u/^d half page · enter inspect · space fold turn · c/e fold all · [/] turns · / search · g/G top/end · q close",
		);
		this.ensureMatches();
		if (this.query && this.matches.length > 0) {
			const rank = this.matches.filter((m) => m <= this.selected).length || this.matches.length;
			hint += this.theme.fg("searchMatchText", `  ${rank}/${this.matches.length} matches`);
		} else if (this.query) {
			hint += this.theme.fg("warning", "  no matches");
		}
		const newBelow = !this.follow && this.selected < this.rows.length - 1 ? this.rows.length - 1 - this.selected : 0;
		if (newBelow > 0) hint += this.theme.fg("warning", `  ↓ ${newBelow} new (G to follow)`);
		if (this.note) hint += this.theme.fg("warning", `  ${this.note}`);
		return hint;
	}

	private renderList(width: number, height: number): string[] {
		if (this.rows.length === 0) {
			return [this.theme.fg("muted", "  loading… or empty session")];
		}
		// (scroll clamping done in render())
		const out: string[] = [];
		for (let i = this.scroll; i < Math.min(this.rows.length, this.scroll + height); i++) {
			const row = this.rows[i]!;
			const line = row.type === "header" ? this.renderHeader(row.turn) : this.renderRecord(row.index, width);
			out.push(i === this.selected ? this.theme.bg("selectedBg", padVisible(line, width)) : line);
		}
		return out;
	}

	private renderHeader(turn: number): string {
		const range = this.store.turnRange(turn);
		const count = range ? range.last - range.first + 1 : 0;
		const open = !this.collapsed.has(turn);
		const usage = this.store.turnUsage(turn);
		const tokens = formatTokens(this.store.turnTokens(turn));
		const cost = usage?.cost?.total !== undefined ? ` · $${usage.cost.total.toFixed(4)}` : "";
		const ts = range ? formatClock(this.store.records[range.first]!.ts) : "";
		const arrow = open ? "▾" : "▸";
		// dsh-style dim rail label; stats trail on the right. Turn 0 = pre-first-message markers.
		return (
			this.theme.fg("muted", `${arrow} ${turn === 0 ? "Setup" : `Turn ${turn}`}`) +
			this.theme.fg("borderMuted", " ─────") +
			this.theme.fg("dim", ` ${ts} · ${tokens} tok${cost}${open ? "" : ` · ${count} records`}`)
		);
	}

	/** dsh-style badge: reverse-video colored tag, fixed width 11 incl. padding. */
	private badge(label: string, color: Parameters<Theme["fg"]>[0]): string {
		return this.theme.inverse(this.theme.fg(color, ` ${label} `)) + " ";
	}

	private renderRecord(index: number, width: number): string {
		const r = this.store.records[index]!;
		const time = this.theme.fg("dim", formatClock(r.ts));
		let body: string;
		switch (r.kind) {
			case "user":
				body = this.badge("USER", kindColor(r)) + clip(r.text, width - 28);
				break;
			case "assistant": {
				const a = r as AssistantRecord;
				const identity = [a.api, a.provider, a.responseModel ?? a.model].filter(Boolean).join("/");
				let meta: string;
				if (a.streaming) {
					meta = this.theme.fg("accent", ` ${SPINNER[this.spinnerIdx % SPINNER.length]} streaming${identity ? ` · ${identity}` : ""}`);
				} else {
					const timing =
						a.ttftMs !== undefined ? ` · live-only TTFT ${formatDuration(a.ttftMs)} · decode ${formatDuration(a.decodeMs)}` : "";
					const terminal = a.errorMessage ? " · error" : a.stopReason ? ` · ${a.stopReason}` : "";
					meta = this.theme.fg(
						"dim",
						` ${formatTokens((a.usage?.input ?? 0) + (a.usage?.output ?? 0) || undefined)} tok${identity ? ` · ${identity}` : ""}${terminal}${timing}`,
					);
					if (a.interrupted) meta += this.theme.fg("muted", " · interrupted");
				}
				body = this.badge("ASSISTANT", kindColor(r)) + clip(a.text, width - 28) + meta;
				break;
			}
			case "tool": {
				const t = r as ToolRecord;
				const color = kindColor(r);
				const state =
					t.status === "running"
						? this.theme.fg("accent", SPINNER[this.spinnerIdx % SPINNER.length])
						: "";
				// dsh ledger: TOOL name {args} → output preview
				const outPreview = t.output ? this.theme.fg("dim", ` → ${clip(t.output, Math.max(10, width - 60))}`) : "";
				body =
					this.badge("TOOL", color) +
					this.theme.fg(color, `${t.name} `) +
					clip(t.argsSummary, width - 44) +
					outPreview +
					` ${state}${this.theme.fg("dim", formatDuration(t.durationMs))}`;
				break;
			}
			case "compaction":
				body =
					this.badge("COMPACT", kindColor(r)) +
					this.theme.fg("muted", clip(r.summary, width - 34)) +
					this.theme.fg("dim", ` (${formatTokens(r.tokensBefore)} tok before)`);
				break;
			case "marker":
				body = this.theme.fg("dim", `─ ${r.text}`);
				break;
		}
		return `  ${body} ${time}`;
	}

	/**
	 * Timeline strip: four lanes (user / assistant / tool / event) over the records
	 * currently visible in the list window — like dsh, which only projects the
	 * loaded ledger page. This keeps columns fine-grained (each column ≈ a
	 * single operation) so complementary lane texture is always visible,
	 * instead of saturating when a whole long session is crammed into one row.
	 * Idle-compressed axis: gaps where nothing runs are removed.
	 */
	private renderTimeline(width: number, listHeight: number): string[] {
		const proj = this.ensureProjection();
		// Window: the contiguous record-index span covered by the visible list
		// rows — collapsed turns' records STAY in the window (dsh: the timeline
		// never reflows on collapse; a header extends the window via its turn's
		// record range).
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = this.scroll; i < Math.min(this.rows.length, this.scroll + listHeight); i++) {
			const row = this.rows[i]!;
			if (row.type === "record") {
				lo = Math.min(lo, row.index);
				hi = Math.max(hi, row.index);
			} else {
				const tr = this.store.turnRange(row.turn);
				if (tr) {
					lo = Math.min(lo, tr.first);
					hi = Math.max(hi, tr.last);
				}
			}
		}
		if (hi < lo) return [];
		const pairs: { r: TrajectoryRecord; idx: number; p: { s: number; e: number } }[] = [];
		for (let i = lo; i <= hi; i++) {
			const r = this.store.records[i]!;
			const p = proj.map.get(r);
			if (p) pairs.push({ r, idx: i, p });
		}
		if (pairs.length === 0) return [];
		const start = Math.min(...pairs.map((x) => x.p.s));
		let end = Math.max(...pairs.map((x) => x.p.e));
		if (end - start < 1000) end = start + 1000;
		const range = { start, end };
		const cols = Math.max(10, width - 9); // " user │" … "│"
		const span = range.end - range.start;
		const bucket = (ts: number) => Math.max(0, Math.min(cols - 1, Math.floor(((ts - range.start) / span) * cols)));

		type Cell = { ch: string; color: Parameters<Theme["fg"]>[0]; priority: number };
		const lanes: (Cell | undefined)[][] = [new Array(cols), new Array(cols), new Array(cols), new Array(cols)];
		/**
		 * Paint [s0, s1) half-open: a column is painted iff it intersects the
		 * interval. Complementary spans (assistant ends where its tool starts)
		 * then tile perfectly with zero boundary double-painting. Points (s0==s1)
		 * paint exactly one column.
		 */
		const put = (lane: number, s0: number, s1: number, ch: string, color: Cell["color"], priority: number): [number, number] => {
			const c0 = bucket(s0);
			let c1 = s1 > s0 ? Math.ceil(((s1 - range.start) / span) * cols) - 1 : c0;
			c1 = Math.max(c0, Math.min(cols - 1, c1));
			for (let c = c0; c <= c1; c++) {
				const cell = lanes[lane]![c];
				if (!cell || cell.priority <= priority) lanes[lane]![c] = { ch, color, priority };
			}
			return [c0, c1];
		};
		const tick = SPINNER[this.spinnerIdx % SPINNER.length];

		// Search-linked timeline dimming (dsh: non-matching spans get opacity 0.14).
		const searching = this.query.length > 0;
		const matchIdx = new Set(this.matches);
		const matchCols = new Set<number>();
		const markMatch = (idx: number, [c0, c1]: [number, number]) => {
			if (matchIdx.has(idx)) for (let c = c0; c <= c1; c++) matchCols.add(c);
		};
		/** Point events share one rail; a + means this time bucket contains multiple events. */
		const putEvent = (idx: number, ts: number, r: TrajectoryRecord) => {
			const style = timelineEventStyle(r);
			if (!style) return;
			const c = bucket(ts);
			const existing = lanes[3]![c];
			if (existing) {
				existing.ch = "+";
				existing.color = "warning";
				existing.priority = Math.max(existing.priority, style.priority);
			} else {
				lanes[3]![c] = { ch: style.glyph, color: style.color, priority: style.priority };
			}
			if (matchIdx.has(idx)) matchCols.add(c);
		};

		for (const { r, idx, p } of pairs) {
			switch (r.kind) {
				case "user":
					markMatch(idx, put(0, p.s, p.s, "█", kindColor(r), 1)); // point event, rectangle glyph like dsh
					break;
				case "assistant": {
					const a = r as AssistantRecord;
					if (a.streaming) {
						put(1, p.s, p.e, "█", "muted", 2); // in flight
						markMatch(idx, put(1, p.e, p.e, tick, "accent", 5));
					} else if (a.ttftMs !== undefined) {
						put(1, p.s, p.s + a.ttftMs, "█", "thinkingLow", 2); // TTFT = dim ramp step
						markMatch(idx, put(1, p.s + a.ttftMs, p.e, "█", "accent", 2)); // decode
					} else {
						// Historical entries only support an estimated persisted-entry window,
						// not a recoverable TTFT/decode split.
						markMatch(idx, put(1, p.s, p.e, "█", "muted", 2));
					}
					break;
				}
				case "tool": {
					markMatch(idx, put(2, p.s, p.e, "█", kindColor(r), 3));
					if (r.status === "running") put(2, p.e, p.e, tick, "accent", 5);
					break;
				}
				case "compaction":
				case "marker":
					putEvent(idx, p.s, r);
					break;
				default:
					break;
			}
		}

		/**
		 * Ownership post-pass: user points and tool glyphs always claim a full
		 * column, so the assistant lane yields
		 * every column they touch — otherwise boundary-sharing looks like
		 * overlap (a user message and the assistant span it triggers share the
		 * same start instant). Sequence-diagram semantics: strict alternation
		 * beats pixel-perfect coverage. Diamonds and spinner ticks survive.
		 */
		for (let c = 0; c < cols; c++) {
			const asstCell = lanes[1]![c];
			if ((lanes[0]![c] || lanes[2]![c]) && asstCell && asstCell.priority <= 2) {
				lanes[1]![c] = undefined;
			}
		}

		// True turn boundaries inside the window: the first column of each turn
		// whose start record is in [lo, hi] (a turn opened before lo is not a
		// boundary — the window merely starts mid-turn).
		const boundaryCols = new Set<number>();
		const recs = this.store.records;
		for (let i = lo; i <= hi; i++) {
			if (i > lo && recs[i]!.turn === recs[i - 1]!.turn) continue;
			const p = proj.map.get(recs[i]!);
			if (p) boundaryCols.add(bucket(p.s));
		}

		// Cursor rectangle: the selected record's full projected span, drawn as
		// an inverse band across all four lanes (dsh highlights the whole span,
		// not just its start column). Header selection spans the entire turn.
		let cur0 = -1;
		let cur1 = -1;
		let curLane = -1; // -1 = all lanes; record rows tint only their own lane
		const selRow = this.rows[this.selected];
		if (selRow) {
			const spanOf = (r: TrajectoryRecord): { s: number; e: number } => proj.map.get(r) ?? { s: r.ts, e: r.ts };
			let selS: number | undefined;
			let selE: number | undefined;
			if (selRow.type === "record") {
				const p = spanOf(this.store.records[selRow.index]!);
				selS = p.s;
				selE = p.e;
			} else {
				const tr = this.store.turnRange(selRow.turn);
				if (tr) {
					selS = spanOf(this.store.records[tr.first]!).s;
				selE = spanOf(this.store.records[tr.last]!).e;
			}
			}
			if (selS !== undefined && selE !== undefined && selE >= range.start && selS <= range.end) {
				cur0 = bucket(selS);
				cur1 = selE > selS ? Math.ceil(((selE - range.start) / span) * cols) - 1 : cur0;
				if (cur1 < cur0) cur1 = cur0; // sub-column span rounds to its start bucket
				if (selRow.type === "record") {
					const k = this.store.records[selRow.index]!.kind;
					curLane = k === "user" ? 0 : k === "assistant" ? 1 : k === "tool" ? 2 : 3;
				}
			}
		}
		const labels = ["user", "asst", "tool", "event"];
		const lines: string[] = [];
		for (let lane = 0; lane < 4; lane++) {
			let body = "";
			for (let c = 0; c < cols; c++) {
				const cell = lanes[lane]![c];
			const inCursor = cur0 >= 0 && c >= cur0 && c <= cur1 && (curLane < 0 || curLane === lane);
				let s: string;
				if (inCursor)
					// selectedBg band + glyphs lifted to text brightness — strong
					// enough to read, still calmer than inverse. Lane-scoped for
					// record rows; turn headers tint all four lanes.
					s = this.theme.bg("selectedBg", cell ? this.theme.fg("text", cell.ch) : " ");
				else if (cell && searching && !matchCols.has(c)) s = this.theme.fg("dim", cell.ch);
				else s = cell ? this.theme.fg(cell.color, cell.ch) : " ";
				// Turn boundary band: a dim bg stripe through all four lanes —
				// glyphs survive, the eye gets a hard vertical edge (the cursor
				// rectangle keeps its inverse highlight instead).
				if (boundaryCols.has(c) && !inCursor) s = this.theme.bg("scrollbarThumb", s);
				body += s;
			}
			lines.push(
				this.theme.fg("dim", ` ${labels[lane]!.padEnd(5)} `) + this.theme.fg("borderMuted", "│") + body + this.theme.fg("borderMuted", "│"),
			);
		}
		// Axis: real clock of the visible window + its busy (idle-compressed) length.
		// Turn boundaries are ticked with ┬ at their lane column (dsh marks them too).
		const wallStart = pairs[0]!.r.ts;
		const wallEnd = Math.max(...pairs.map((x) => this.recordEnd(x.r)));
		const hasHistoricalWindows = pairs.some((x) => x.r.kind === "assistant" && x.r.ttftMs === undefined && x.r.startTs !== undefined);
		const mode = `busy ${formatDuration(range.end - range.start)} / wall ${formatDuration(wallEnd - wallStart)}${hasHistoricalWindows ? " · history est." : ""}`;
		const left = `        └${formatClock(wallStart)} `;
		const right = ` ${formatClock(wallEnd)}┘`;
		const fill = Math.max(1, cols - visibleWidth(left + mode + right) + 2);
		const leftW = visibleWidth(left);
		const fillChars: string[] = new Array(fill).fill("─");
		for (const c of boundaryCols) {
			const idx = 8 + c - leftW; // lanes start 8 chars in (" event │")
			if (idx >= 0 && idx < fill) fillChars[idx] = "┬";
		}
		// Emit the fill as color runs: ─ in borderMuted, ┬ in dim.
		let fillStr = "";
		let run = "";
		let runTick = fillChars[0] === "┬";
		for (const ch of fillChars) {
			const isTick = ch === "┬";
			if (isTick !== runTick) {
				fillStr += this.theme.fg(runTick ? "dim" : "borderMuted", run);
				run = "";
				runTick = isTick;
			}
			run += ch;
		}
		fillStr += this.theme.fg(runTick ? "dim" : "borderMuted", run);
		lines.push(
			this.theme.fg("dim", left) +
				fillStr +
				this.theme.fg("dim", ` ${mode} `) +
				this.theme.fg("borderMuted", "─") +
				this.theme.fg("dim", right),
		);
		return lines;
	}


	private renderInspector(width: number, height: number): string[] {
		const { record, expanded, showRaw } = this.inspector!;
		const lines = inspectorLines(record, this.theme, width, expanded, showRaw);
		this.inspector!.scroll = Math.max(0, Math.min(this.inspector!.scroll, Math.max(0, lines.length - height)));
		const view = lines.slice(this.inspector!.scroll, this.inspector!.scroll + height);
		if (view.length === 0) return [this.theme.fg("muted", "  (empty)")];
		return view;
	}
}

// ---------------------------------------------------------------------------
// helpers

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Bounded metadata search text; avoid serializing raw/base64 inspector references. */
function compactJson(value: unknown): string {
	if (value === undefined) return "";
	try {
		return clip(JSON.stringify(value) ?? "", 2_000);
	} catch {
		return "[unserializable]";
	}
}

function padVisible(s: string, width: number): string {
	const w = visibleWidth(s);
	return w >= width ? s : s + " ".repeat(width - w);
}

function badgeColor(r: TrajectoryRecord): Parameters<Theme["fg"]>[0] {
	return kindColor(r);
}

/** Compact event glyphs use semantic colors so they remain recognizable without opening the list. */
function timelineEventStyle(r: TrajectoryRecord): { glyph: string; color: Parameters<Theme["fg"]>[0]; priority: number } | undefined {
	switch (r.kind) {
		case "compaction":
			return { glyph: "◆", color: kindColor(r), priority: 6 };
		case "marker":
			switch (r.marker) {
				case "model_change":
					return { glyph: "M", color: "accent", priority: 5 };
				case "thinking_change":
					return { glyph: "T", color: "thinkingLow", priority: 5 };
				case "branch":
					return { glyph: "↗", color: "syntaxKeyword", priority: 4 };
				case "bash":
					return { glyph: "$", color: "syntaxString", priority: 3 };
				case "custom":
					return { glyph: "·", color: "muted", priority: 2 };
				case "note":
					return { glyph: "•", color: "muted", priority: 2 };
				case "unknown":
					return { glyph: "?", color: "warning", priority: 1 };
			}
		default:
			return undefined;
	}
}

/**
 * Single source of truth for record-kind colors — used by list badges, the
 * inspector header, and non-event timeline cells, so a record reads the same
 * hue everywhere (dsh: lane-specific hues).
 */
function kindColor(r: TrajectoryRecord): Parameters<Theme["fg"]>[0] {
	switch (r.kind) {
		case "user":
			return "borderAccent"; // dsh: user spans are vivid blue — a bright point event
		case "assistant":
			// pi's own calm teal — the assistant IS pi; TTFT rides the accent→thinkingLow ramp
			return "accent";
		case "tool":
			// Errors and interruptions retain state colors; all other tools get a stable name-based hue.
			return r.status === "error" ? "error" : r.status === "interrupted" ? "muted" : toolColor(r.name);
		case "compaction":
			return "success"; // dsh: context spans are desaturated green, not warn yellow
		case "marker":
			return "muted";
	}
}

/** Deterministically assign built-in and custom tool names a theme-aware hue. */
function toolColor(name: string): (typeof TOOL_COLORS)[number] {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return TOOL_COLORS[(hash >>> 0) % TOOL_COLORS.length]!;
}

function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line = raw;
		while (visibleWidth(line) > width) {
			let cut = width;
			const space = line.lastIndexOf(" ", width);
			if (space > width * 0.4) cut = space;
			out.push(line.slice(0, cut));
			line = line.slice(cut).trimStart();
		}
		out.push(line);
	}
	return out;
}

function inspectorLines(r: TrajectoryRecord, theme: Theme, width: number, expanded: boolean, showRaw: boolean): string[] {
	const w = Math.max(20, width - 4);
	const head = theme.inverse(theme.fg(badgeColor(r), ` ${r.kind.toUpperCase()} `)) + theme.fg("muted", ` ${formatClock(r.ts)}`);
	const lines: string[] = [head];
	const section = (title: string) => {
		lines.push("", theme.fg("borderMuted", " ── ") + theme.bold(theme.fg("accent", title)) + theme.fg("borderMuted", " ─────────"));
	};
	const push = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => {
		for (const line of wrapText(text, w)) lines.push(theme.fg(color, line));
	};
	const label = (text: string) => lines.push(theme.fg("toolTitle", ` ${text}`));
	const long = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => {
		const limited = limitText(text, expanded ? 60_000 : 4_000);
		push(limited.text, color);
		if (limited.truncated) lines.push(theme.fg("warning", ` … truncated; press x to ${expanded ? "collapse" : "expand"} text`));
	};
	const json = (value: unknown, color: Parameters<Theme["fg"]>[0] = "toolOutput") => long(safeInspectorJson(value, expanded), color);

	section("Overview");
	if (r.entryId) lines.push(theme.fg("muted", ` entry id: ${r.entryId}`));
	appendTimeSemantics(lines, r, theme);

	switch (r.kind) {
		case "user":
			section("Message content · stored order");
			appendContentBlocks(lines, r.content, r.text, theme, w, expanded);
			if (r.imageCount > 0) lines.push(theme.fg("muted", ` images: ${r.imageCount} · base64 is never displayed`));
			break;
		case "assistant": {
			section("Model & terminal state");
			appendMetadata(lines, [
				["api", r.api],
				["provider", r.provider],
				["model", r.model],
				["response model", r.responseModel],
				["response id", r.responseId],
				["stop reason", r.stopReason],
				["raw stop reason", r.rawStopReason],
			], theme);
			if (r.errorMessage) {
				label("error message:");
				long(r.errorMessage, "error");
			}
			section("Timing semantics");
			if (r.ttftMs !== undefined) {
				lines.push(theme.fg("accent", ` live-only: TTFT ${formatDuration(r.ttftMs)} · decode ${formatDuration(r.decodeMs)}`));
				lines.push(theme.fg("muted", " unavailable in JSONL; historical replay never reconstructs it"));
			} else if (r.inspector?.source === "history" && r.startTs !== undefined) {
				lines.push(theme.fg("muted", ` estimated persisted-entry window: ${formatTimestamp(r.startTs)} → ${formatTimestamp(r.ts)}`));
				lines.push(theme.fg("muted", " not TTFT or decode timing"));
			} else {
				lines.push(theme.fg("muted", " no live timing was observed for this record"));
			}
			section("Usage & cost");
			appendUsage(lines, r.usage, theme);
			if (r.diagnostics !== undefined) {
				section("Diagnostics");
				json(r.diagnostics);
			}
			section("Message content · stored order");
			appendContentBlocks(lines, r.content, r.text, theme, w, expanded);
			break;
		}
		case "tool": {
			section("Tool call");
			lines.push(theme.fg("muted", ` ${r.name} · ${r.status}${r.durationMs !== undefined ? ` · ${formatDuration(r.durationMs)}` : ""}`));
			appendMetadata(lines, [["tool call id", r.toolCallId], ["namespace", r.namespace]], theme);
			if (r.args !== undefined) {
				label("arguments:");
				json(r.args);
			}
			if (r.result) {
				section("Tool result");
				appendToolResultTimes(lines, r, theme);
				appendMetadata(lines, [
					["tool call id", r.result.toolCallId],
					["tool name", r.result.toolName],
					["is error", r.result.isError === undefined ? undefined : String(r.result.isError)],
					["added tools", r.result.addedToolNames?.join(", ")],
				], theme);
				if (r.result.details !== undefined) {
					label("details:");
					json(r.result.details);
				}
				if (r.result.usage) {
					label("nested usage & cost:");
					appendUsage(lines, r.result.usage, theme);
				}
				if (r.result.content !== undefined) {
					label("content · stored order:");
					appendContentBlocks(lines, r.result.content, r.output ?? "", theme, w, expanded);
				}
			}
			if (r.output && r.result?.content === undefined) {
				label("output:");
				long(r.output, "toolOutput");
			}
			break;
		}
		case "compaction":
			section("Compaction");
			lines.push(theme.fg("muted", ` tokens before: ${formatTokens(r.tokensBefore)}`));
			label("summary:");
			long(r.summary);
			if (r.usage) {
				section("Usage & cost");
				appendUsage(lines, r.usage, theme);
			}
			if (r.details !== undefined) {
				section("Details");
				json(r.details);
			}
			break;
		case "marker":
			section(r.marker === "unknown" ? "Unsupported entry" : "Marker");
			lines.push(theme.fg("muted", ` marker: ${r.marker}`));
			long(r.text);
			if (r.detail) {
				label("detail:");
				long(r.detail, "muted");
			}
			if (r.usage) {
				section("Usage & cost");
				appendUsage(lines, r.usage, theme);
			}
			if (r.details !== undefined) {
				section("Details");
				json(r.details);
			}
			break;
	}

	if (showRaw) {
		section("Raw source · sanitized");
		appendRawInspector(lines, r, theme, w, expanded);
	} else if (r.inspector?.rawEntry !== undefined || (r.kind === "tool" && r.result?.raw !== undefined)) {
		lines.push("", theme.fg("muted", " Raw session/event JSON hidden · press r to inspect (sanitized)"));
	}
	return lines;
}

function appendTimeSemantics(lines: string[], r: TrajectoryRecord, theme: Theme): void {
	const source = r.inspector;
	if (!source) {
		lines.push(theme.fg("muted", ` observed time: ${formatTimestamp(r.ts)}`));
		return;
	}
	lines.push(theme.fg("muted", ` source: ${source.source}${source.entryType ? ` · ${source.entryType}` : ""}`));
	if (source.source === "history") {
		const message = source.messageTimestamp === undefined ? undefined : formatTimestamp(source.messageTimestamp);
		const entry = source.entryTimestamp === undefined ? formatTimestamp(r.ts) : formatTimestamp(source.entryTimestamp);
		lines.push(theme.fg("muted", ` historical timestamps: ${message ? `message start (message.timestamp) ${message} · ` : ""}entry persisted ${entry}`));
	} else {
		lines.push(theme.fg("muted", ` live observed time: ${formatTimestamp(r.ts)}${source.messageTimestamp !== undefined ? ` · message.timestamp ${formatTimestamp(source.messageTimestamp)}` : ""}`));
	}
}

function appendMetadata(lines: string[], pairs: [string, string | undefined][], theme: Theme): void {
	for (const [name, value] of pairs) if (value) lines.push(theme.fg("muted", ` ${name}: ${value}`));
}

function appendToolResultTimes(lines: string[], r: ToolRecord, theme: Theme): void {
	const result = r.result;
	if (!result || (result.messageTimestamp === undefined && result.entryTimestamp === undefined)) return;
	const message = result.messageTimestamp === undefined ? undefined : formatTimestamp(result.messageTimestamp);
	const entry = result.entryTimestamp === undefined ? undefined : formatTimestamp(result.entryTimestamp);
	if (r.inspector?.source === "history") {
		lines.push(theme.fg("muted", ` result timestamps: ${message ? `message start (message.timestamp) ${message}` : "message timestamp unavailable"}${entry ? ` · entry persisted ${entry}` : ""}`));
	} else {
		lines.push(theme.fg("muted", ` live result timestamp: ${message ?? entry ?? "unknown"}`));
	}
}

function appendUsage(lines: string[], usage: UsageInfo | undefined, theme: Theme): void {
	if (!usage) {
		lines.push(theme.fg("muted", " no persisted usage reported"));
		return;
	}
	lines.push(theme.fg("muted", ` tokens: input ${formatTokens(usage.input)} · output ${formatTokens(usage.output)} · total ${formatTokens(usage.totalTokens)}`));
	lines.push(theme.fg("muted", ` cache: read ${formatTokens(usage.cacheRead)} · write ${formatTokens(usage.cacheWrite)} · write-1h ${formatTokens(usage.cacheWrite1h)} · reasoning ${formatTokens(usage.reasoning)} (subset of output)`));
	if (usage.cost) {
		lines.push(theme.fg("muted", ` cost: input ${formatMoney(usage.cost.input)} · output ${formatMoney(usage.cost.output)} · cache-read ${formatMoney(usage.cost.cacheRead)} · cache-write ${formatMoney(usage.cost.cacheWrite)} · total ${formatMoney(usage.cost.total)}`));
	}
}

function appendContentBlocks(
	lines: string[],
	content: unknown,
	fallbackText: string,
	theme: Theme,
	width: number,
	expanded: boolean,
): void {
	const push = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => {
		for (const line of wrapText(text, width)) lines.push(theme.fg(color, line));
	};
	const long = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => {
		const limited = limitText(text, expanded ? 60_000 : 4_000);
		push(limited.text, color);
		if (limited.truncated) lines.push(theme.fg("warning", ` … truncated; press x to ${expanded ? "collapse" : "expand"} text`));
	};
	if (typeof content === "string") {
		lines.push(theme.fg("muted", " [0] text"));
		long(content);
		return;
	}
	if (!Array.isArray(content)) {
		long(fallbackText || "(no content)");
		return;
	}
	const blockLimit = 100;
	for (let index = 0; index < Math.min(content.length, blockLimit); index++) {
		const block = content[index] as any;
		const type = typeof block?.type === "string" ? block.type : "unknown";
		lines.push(theme.fg("muted", ` [${index}] ${type}`));
		switch (type) {
			case "text":
				long(typeof block.text === "string" ? block.text : "", "text");
				if (typeof block.textSignature === "string") lines.push(theme.fg("muted", ` text signature: [hidden; ${block.textSignature.length} chars]`));
				break;
			case "thinking":
				if (block.redacted) lines.push(theme.fg("warning", " thinking: [redacted by provider]"));
				else long(typeof block.thinking === "string" ? block.thinking : "", "thinkingText");
				if (typeof block.thinkingSignature === "string") lines.push(theme.fg("muted", ` thinking signature: [hidden; ${block.thinkingSignature.length} chars]`));
				break;
			case "image":
				lines.push(theme.fg("muted", ` image: ${block.mimeType ?? "unknown mime"}; base64 omitted (${typeof block.data === "string" ? block.data.length : 0} chars)`));
				break;
			case "toolCall":
				lines.push(theme.fg("muted", ` call: id ${block.id ?? "?"} · name ${block.name ?? "?"}${block.namespace ? ` · namespace ${block.namespace}` : ""}`));
				lines.push(theme.fg("toolTitle", " arguments:"));
				long(safeInspectorJson(block.arguments, expanded), "toolOutput");
				if (typeof block.thoughtSignature === "string") lines.push(theme.fg("muted", ` thought signature: [hidden; ${block.thoughtSignature.length} chars]`));
				break;
			default:
				long(safeInspectorJson(block, expanded), "toolOutput");
				break;
		}
	}
	if (content.length > blockLimit) lines.push(theme.fg("warning", ` … ${content.length - blockLimit} additional content blocks omitted`));
}

function appendRawInspector(lines: string[], r: TrajectoryRecord, theme: Theme, width: number, expanded: boolean): void {
	const source = r.inspector;
	if (!source) return;
	const pushRaw = (label: string, value: unknown) => {
		if (value === undefined) return;
		lines.push("", theme.fg("toolTitle", ` ${label} (sanitized):`));
		const limited = limitText(safeInspectorJson(value, expanded), expanded ? 60_000 : 12_000);
		for (const line of wrapText(limited.text, width)) lines.push(theme.fg("toolOutput", line));
		if (limited.truncated) lines.push(theme.fg("warning", ` … raw JSON truncated; press x to ${expanded ? "collapse" : "expand"} text`));
	};
	pushRaw(source.source === "history" ? "raw session entry" : "raw live event/message", source.rawEntry);
	if (source.rawMessage && source.rawMessage !== source.rawEntry) pushRaw("raw message", source.rawMessage);
	if (r.kind === "tool" && r.result?.raw !== undefined && r.result.raw !== source.rawEntry && r.result.raw !== source.rawMessage)
		pushRaw("raw tool result", r.result.raw);
}

function safeInspectorJson(value: unknown, expanded: boolean): string {
	try {
		return JSON.stringify(sanitizeForInspector(value, expanded), null, 2) ?? "";
	} catch {
		return "[unserializable value]";
	}
}

function sanitizeForInspector(value: unknown, expanded: boolean, depth = 0, seen = new WeakSet<object>()): unknown {
	const maxString = expanded ? 16_000 : 2_000;
	if (typeof value === "string") return limitText(value, maxString).text;
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	if (depth > 12) return "[nested value omitted]";
	seen.add(value);
	if (Array.isArray(value)) {
		const limit = expanded ? 300 : 100;
		const result = value.slice(0, limit).map((item) => sanitizeForInspector(item, expanded, depth + 1, seen));
		if (value.length > limit) result.push(`[${value.length - limit} additional items omitted]`);
		return result;
	}
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	const keys = Object.keys(source);
	const limit = expanded ? 200 : 100;
	for (const key of keys.slice(0, limit)) {
		const item = source[key];
		if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
			result[key] = typeof item === "string" ? `[hidden; ${item.length} chars]` : "[hidden]";
		} else if (key === "data" && source.type === "image") {
			result[key] = typeof item === "string" ? `[omitted image/base64; ${item.length} chars]` : "[omitted image data]";
		} else {
			result[key] = sanitizeForInspector(item, expanded, depth + 1, seen);
		}
	}
	if (keys.length > limit) result["…"] = `${keys.length - limit} additional keys omitted`;
	return result;
}

function limitText(text: string, max: number): { text: string; truncated: boolean } {
	return text.length > max ? { text: `${text.slice(0, max)}\n…`, truncated: true } : { text, truncated: false };
}

function formatTimestamp(ts: number): string {
	return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : "unknown";
}

function formatMoney(value: number | undefined): string {
	return value === undefined ? "-" : `$${value.toFixed(6)}`;
}
