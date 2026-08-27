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
} from "../types.ts";

type Row = { type: "header"; turn: number } | { type: "record"; index: number };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const OPEN_ANIM_MS = 120;

export class TraceOverlay implements Component {
	private rows: Row[] = [];
	private selected = 0;
	private scroll = 0;
	private collapsed = new Set<number>();
	private inspector: { record: TrajectoryRecord; scroll: number } | null = null;
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
		this.store.subscribe(() => {
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


	private rebuildRows(): void {
		const rows: Row[] = [];
		for (const turn of this.store.turns()) {
			const range = this.store.turnRange(turn);
			if (!range) continue;
			rows.push({ type: "header", turn });
			if (this.collapsed.has(turn)) continue;
			for (let i = range.first; i <= range.last; i++) rows.push({ type: "record", index: i });
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
			this.done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.move(-1);
		else if (matchesKey(data, "down") || data === "j") this.move(1);
		else if (data === "g") {
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
		} else if (matchesKey(data, "space") || matchesKey(data, "return")) {
			this.activate();
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
			this.inspector = null;
		} else if (matchesKey(data, "up") || data === "k") {
			this.inspector!.scroll = Math.max(0, this.inspector!.scroll - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.inspector!.scroll++;
		}
		this.tui.requestRender();
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
		this.follow = false;
	}

	private select(idx: number): void {
		this.selected = Math.max(0, Math.min(this.rows.length - 1, idx));
	}

	private activate(): void {
		const row = this.rows[this.selected];
		if (!row) return;
		if (row.type === "header") {
			if (this.collapsed.has(row.turn)) this.collapsed.delete(row.turn);
			else this.collapsed.add(row.turn);
			this.rebuildRows();
			return;
		}
		const record = this.store.records[row.index];
		if (record) this.inspector = { record, scroll: 0 };
	}

	// ------------------------------------------------------------------ search

	private searchableText(r: TrajectoryRecord): string {
		switch (r.kind) {
			case "user":
				return r.text;
			case "assistant":
				return r.text + (r.thinkingText ?? "");
			case "tool":
				return `${r.name} ${r.argsSummary} ${r.output ?? ""}`;
			case "compaction":
				return r.summary;
			case "marker":
				return `${r.text} ${r.detail ?? ""}`;
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

	private selectedRecordTs(): number | undefined {
		const row = this.rows[this.selected];
		if (!row) return undefined;
		const rec = row.type === "record" ? this.store.records[row.index]! : undefined;
		if (rec) return this.ensureProjection().map.get(rec)?.s ?? rec.ts;
		const range = this.store.turnRange((row as { type: "header"; turn: number }).turn);
		if (!range) return undefined;
		const first = this.store.records[range.first]!;
		return this.ensureProjection().map.get(first)?.s ?? first.ts;
	}

	private recordEnd(r: TrajectoryRecord): number {
		if (r.kind === "assistant") {
			if (r.streaming) return Date.now();
			if (r.ttftMs !== undefined) return r.ts + r.ttftMs + (r.decodeMs ?? 0);
			return r.ts; // replay: ts is completion time; span start via recordStart
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
		const chrome = 4 + (showTimeline ? 4 : 0); // timeline: 3 lanes + time axis
		const bodyHeight = Math.max(4, Math.floor(termRows * 0.86) - chrome);

		const title =
			this.theme.bold(this.theme.fg("accent", ` trace `)) +
			this.theme.fg("muted", `${this.title} · ${this.store.records.length} records`);
		const sep = this.theme.fg("borderMuted", "─".repeat(width));
		const hint = this.renderHint();

		// Clamp scroll before both the list and the timeline consume the window.
		if (!this.inspector) {
			if (this.selected < this.scroll) this.scroll = this.selected;
			if (this.selected >= this.scroll + bodyHeight) this.scroll = this.selected - bodyHeight + 1;
		}
		const body = this.inspector ? this.renderInspector(width, bodyHeight) : this.renderList(width, bodyHeight);

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
		if (this.inspector) return this.theme.fg("muted", " j/k scroll · esc back");
		let hint = this.theme.fg("muted", " j/k move · enter inspect · space fold · / search · g/G top/end · q close");
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
		const tokens = formatTokens(this.store.turnTokens(turn));
		const ts = range ? formatClock(this.store.records[range.first]!.ts) : "";
		const arrow = open ? "▾" : "▸";
		// dsh-style dim rail label; stats trail on the right
		return (
			this.theme.fg("muted", `${arrow} Turn ${turn}`) +
			this.theme.fg("borderMuted", " ─────") +
			this.theme.fg("dim", ` ${ts} · ${tokens} tok${open ? "" : ` · ${count} records`}`)
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
				body = this.badge("USER", "userMessageText") + clip(r.text, width - 28);
				break;
			case "assistant": {
				const a = r as AssistantRecord;
				let meta: string;
				if (a.streaming) {
					meta = this.theme.fg("warning", ` ${SPINNER[this.spinnerIdx % SPINNER.length]} streaming`);
				} else {
					const timing =
						a.ttftMs !== undefined ? ` TTFT ${formatDuration(a.ttftMs)} · decode ${formatDuration(a.decodeMs)}` : "";
					meta = this.theme.fg(
						"dim",
						` ${formatTokens((a.usage?.input ?? 0) + (a.usage?.output ?? 0) || undefined)} tok${timing}`,
					);
				}
				body = this.badge("ASSISTANT", "accent") + clip(a.text, width - 28) + meta;
				break;
			}
			case "tool": {
				const t = r as ToolRecord;
				const badgeColor =
					t.status === "ok"
						? "warning"
						: t.status === "error"
							? "error"
							: t.status === "interrupted"
								? "muted"
								: "warning";
				const state =
					t.status === "running"
						? this.theme.fg("warning", SPINNER[this.spinnerIdx % SPINNER.length])
						: "";
				// dsh ledger: TOOL name {args} → output preview
				const outPreview = t.output ? this.theme.fg("dim", ` → ${clip(t.output, Math.max(10, width - 60))}`) : "";
				body =
					this.badge("TOOL", badgeColor) +
					this.theme.fg("toolTitle", `${t.name} `) +
					clip(t.argsSummary, width - 44) +
					outPreview +
					` ${state}${this.theme.fg("dim", formatDuration(t.durationMs))}`;
				break;
			}
			case "compaction":
				body =
					this.badge("COMPACT", "muted") +
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
	 * Timeline strip (FR-6): three lanes (user / assistant / tool), one column per
	 * time bucket. Color carries meaning, not shape — TTFT warning vs decode accent,
	/**
	 * Timeline strip: three lanes (user / assistant / tool) over the records
	 * currently visible in the list window — like dsh, which only projects the
	 * loaded ledger page. This keeps columns fine-grained (each column ≈ a
	 * single operation) so complementary lane texture is always visible,
	 * instead of saturating when a whole long session is crammed into one row.
	 * Idle-compressed axis: gaps where nothing runs are removed.
	 */
	private renderTimeline(width: number, listHeight: number): string[] {
		const proj = this.ensureProjection();
		const visible: TrajectoryRecord[] = [];
		for (let i = this.scroll; i < Math.min(this.rows.length, this.scroll + listHeight); i++) {
			const row = this.rows[i]!;
			if (row.type === "record") visible.push(this.store.records[row.index]!);
		}
		const pairs: { r: TrajectoryRecord; p: { s: number; e: number } }[] = [];
		for (const r of visible) {
			const p = proj.map.get(r);
			if (p) pairs.push({ r, p });
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
		const lanes: (Cell | undefined)[][] = [new Array(cols), new Array(cols), new Array(cols)];
		/**
		 * Paint [s0, s1) half-open: a column is painted iff it intersects the
		 * interval. Complementary spans (assistant ends where its tool starts)
		 * then tile perfectly with zero boundary double-painting. Points (s0==s1)
		 * paint exactly one column.
		 */
		const put = (lane: number, s0: number, s1: number, ch: string, color: Cell["color"], priority: number) => {
			const c0 = bucket(s0);
			let c1 = s1 > s0 ? Math.ceil(((s1 - range.start) / span) * cols) - 1 : c0;
			c1 = Math.max(c0, Math.min(cols - 1, c1));
			for (let c = c0; c <= c1; c++) {
				const cell = lanes[lane]![c];
				if (!cell || cell.priority <= priority) lanes[lane]![c] = { ch, color, priority };
			}
		};
		const tick = SPINNER[this.spinnerIdx % SPINNER.length];

		for (const { r, p } of pairs) {
			switch (r.kind) {
				case "user":
					put(0, p.s, p.s, "●", "userMessageText", 1);
					break;
				case "assistant": {
					const a = r as AssistantRecord;
					if (a.streaming) {
						put(1, p.s, p.e, "█", "muted", 2); // in flight
						put(1, p.e, p.e, tick, "accent", 5);
					} else if (a.ttftMs !== undefined) {
						put(1, p.s, p.s + a.ttftMs, "█", "muted", 2); // TTFT = gray
						put(1, p.s + a.ttftMs, p.e, "█", "accent", 2); // decode
					} else {
						put(1, p.s, p.e, "█", "accent", 2); // replay: approximated LLM span
					}
					break;
				}
				case "tool": {
					const color: Cell["color"] = r.status === "error" ? "error" : "warning";
					put(2, p.s, p.e, "█", color, 3);
					if (r.status === "running") put(2, p.e, p.e, tick, "accent", 5);
					break;
				}
				case "compaction":
					put(1, p.s, p.s, "◆", "warning", 4);
					break;
				default:
					break;
			}
		}

		/**
		 * Ownership post-pass: a tool glyph always claims a full column (even a
		 * 0.0s tool paints one), so the assistant lane must yield every column a
		 * tool touches — otherwise sub-column tools look like overlaps. The lanes
		 * are a sequence diagram, not an area chart: strict alternation beats
		 * pixel-perfect coverage. Diamonds and spinner ticks are never erased.
		 */
		for (let c = 0; c < cols; c++) {
			const asstCell = lanes[1]![c];
			if (lanes[2]![c] && asstCell && asstCell.priority <= 2) {
				lanes[1]![c] = undefined;
			}
		}

		const selTs = this.selectedRecordTs();
		const cursorCol = selTs !== undefined && selTs >= range.start && selTs <= range.end ? bucket(selTs) : -1;
		const labels = ["user", "asst", "tool"];
		const lines: string[] = [];
		for (let lane = 0; lane < 3; lane++) {
			let body = "";
			for (let c = 0; c < cols; c++) {
				const cell = lanes[lane]![c];
				if (c === cursorCol) body += this.theme.inverse(cell ? cell.ch : " ");
				else body += cell ? this.theme.fg(cell.color, cell.ch) : " ";
			}
			lines.push(
				this.theme.fg("dim", ` ${labels[lane]!} `) + this.theme.fg("borderMuted", "│") + body + this.theme.fg("borderMuted", "│"),
			);
		}
		// Axis: real clock of the visible window + its busy (idle-compressed) length.
		const wallStart = pairs[0]!.r.ts;
		const wallEnd = Math.max(...pairs.map((x) => this.recordEnd(x.r)));
		const mode = `busy ${formatDuration(range.end - range.start)} / wall ${formatDuration(wallEnd - wallStart)}`;
		const left = `       └${formatClock(wallStart)} `;
		const right = ` ${formatClock(wallEnd)}┘`;
		const fill = Math.max(1, cols - visibleWidth(left + mode + right) + 2);
		lines.push(
			this.theme.fg("dim", left) +
				this.theme.fg("borderMuted", "─".repeat(fill)) +
				this.theme.fg("dim", ` ${mode} `) +
				this.theme.fg("borderMuted", "─") +
				this.theme.fg("dim", right),
		);
		return lines;
	}


	private renderInspector(width: number, height: number): string[] {
		const { record, scroll } = this.inspector!;
		const lines = inspectorLines(record, this.theme, width);
		const view = lines.slice(scroll, scroll + height);
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

function padVisible(s: string, width: number): string {
	const w = visibleWidth(s);
	return w >= width ? s : s + " ".repeat(width - w);
}

function badgeColor(r: TrajectoryRecord): Parameters<Theme["fg"]>[0] {
	switch (r.kind) {
		case "user":
			return "userMessageText";
		case "assistant":
			return "accent";
		case "tool":
			return r.status === "error" ? "error" : "warning";
		default:
			return "muted";
	}
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

function inspectorLines(r: TrajectoryRecord, theme: Theme, width: number): string[] {
	const w = Math.max(20, width - 4);
	const head = theme.inverse(theme.fg(badgeColor(r), ` ${r.kind.toUpperCase()} `)) + theme.fg("muted", ` ${formatClock(r.ts)}`);
	const lines: string[] = [head, ""];
	const push = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => {
		for (const l of wrapText(text, w)) lines.push(theme.fg(color, l));
	};

	switch (r.kind) {
		case "user":
			push(r.text);
			if (r.imageCount > 0) lines.push(theme.fg("muted", ` [${r.imageCount} image(s)]`));
			break;
		case "assistant": {
			if (r.model) lines.push(theme.fg("muted", ` model: ${r.model}`));
			if (r.ttftMs !== undefined)
				lines.push(theme.fg("muted", ` timing: TTFT ${formatDuration(r.ttftMs)} · decode ${formatDuration(r.decodeMs)}`));
			if (r.usage) {
				lines.push(
					theme.fg(
						"muted",
						` tokens: in ${formatTokens(r.usage.input)} · out ${formatTokens(r.usage.output)} · cache ${formatTokens(r.usage.cacheRead)}` +
							(r.usage.cost?.total !== undefined ? ` · $${r.usage.cost.total.toFixed(4)}` : ""),
					),
				);
			}
			if (r.stopReason) lines.push(theme.fg("muted", ` stop: ${r.stopReason}`));
			lines.push("");
			push(r.text || "(no text)");
			if (r.thinkingText) {
				lines.push("", theme.fg("thinkingText", " ── thinking ──"));
				push(r.thinkingText, "thinkingText");
			}
			break;
		}
		case "tool": {
			lines.push(
				theme.fg("muted", ` ${r.name} · ${r.status}${r.durationMs !== undefined ? ` · ${formatDuration(r.durationMs)}` : ""}`),
				"",
			);
			if (r.args !== undefined) {
				lines.push(theme.fg("toolTitle", " args:"));
				push(JSON.stringify(r.args, null, 2) ?? "", "toolOutput");
			}
			if (r.output) {
				lines.push("", theme.fg("toolTitle", " output:"));
				const out = r.output.length > 20_000 ? `${r.output.slice(0, 20_000)}\n… (truncated)` : r.output;
				push(out, "toolOutput");
			}
			break;
		}
		case "compaction":
			lines.push(theme.fg("muted", ` tokens before: ${formatTokens(r.tokensBefore)}`), "");
			push(r.summary);
			break;
		case "marker":
			push(r.text);
			if (r.detail) {
				lines.push("");
				push(r.detail, "muted");
			}
			break;
	}
	return lines;
}
