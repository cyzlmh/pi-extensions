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
/** Zoom window halves/doubles around the selected record's timestamp. */
const ZOOM_FACTOR = 3;
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
	/** Timeline zoom window [startMs, endMs]; null = full range. */
	private zoom: { start: number; end: number } | null = null;
	private openedAt = Date.now();

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

	private inZoomWindow(ts: number): boolean {
		return !this.zoom || (ts >= this.zoom.start && ts <= this.zoom.end);
	}

	private rebuildRows(): void {
		const rows: Row[] = [];
		for (const turn of this.store.turns()) {
			const range = this.store.turnRange(turn);
			if (!range) continue;
			const visibleIdx: number[] = [];
			for (let i = range.first; i <= range.last; i++) {
				if (this.inZoomWindow(this.store.records[i]!.ts)) visibleIdx.push(i);
			}
			if (this.zoom && visibleIdx.length === 0) continue;
			rows.push({ type: "header", turn });
			if (this.collapsed.has(turn)) continue;
			for (const i of visibleIdx) rows.push({ type: "record", index: i });
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
		} else if (data === "+") {
			this.adjustZoom(1 / ZOOM_FACTOR);
		} else if (data === "-") {
			this.adjustZoom(ZOOM_FACTOR);
		} else if (data === "0") {
			this.zoom = null;
			this.rebuildRows();
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

	// ------------------------------------------------------------------ zoom

	private adjustZoom(factor: number): void {
		const range = this.fullRange();
		if (!range) return;
		const center = this.selectedRecordTs() ?? (range.start + range.end) / 2;
		const span = Math.max(1000, (this.zoom ? this.zoom.end - this.zoom.start : range.end - range.start) * factor);
		if (span >= range.end - range.start) {
			this.zoom = null;
		} else {
			let start = center - span / 2;
			start = Math.max(range.start, Math.min(start, range.end - span));
			this.zoom = { start, end: start + span };
		}
		this.rebuildRows();
		// keep selection on a visible record
		if (this.rows.length > 0 && this.rows[this.selected]?.type === "header") this.move(1);
	}

	private fullRange(): { start: number; end: number } | null {
		const recs = this.store.records;
		if (recs.length === 0) return null;
		return { start: recs[0]!.ts, end: Math.max(recs[recs.length - 1]!.ts, Date.now()) };
	}

	private selectedRecordTs(): number | undefined {
		const row = this.rows[this.selected];
		if (!row) return undefined;
		if (row.type === "record") return this.store.records[row.index]!.ts;
		const range = this.store.turnRange(row.turn);
		return range ? this.store.records[range.first]!.ts : undefined;
	}

	// ------------------------------------------------------------------ render

	invalidate(): void {
		// theme changed — colors are re-read every render, nothing cached
	}

	render(width: number): string[] {
		const termRows = process.stdout.rows ?? 24;
		const narrow = width < 80;
		const showTimeline = !narrow && this.store.records.length > 1;
		const chrome = 4 + (showTimeline ? 1 : 0);
		const bodyHeight = Math.max(4, Math.floor(termRows * 0.86) - chrome);

		const title =
			this.theme.bold(this.theme.fg("accent", ` trace `)) +
			this.theme.fg("muted", `${this.title} · ${this.store.records.length} records`);
		const sep = this.theme.fg("borderMuted", "─".repeat(width));
		const hint = this.renderHint();

		const body = this.inspector ? this.renderInspector(width, bodyHeight) : this.renderList(width, bodyHeight);

		const lines = [title, sep, ...body];
		if (showTimeline) lines.push(this.renderTimeline(width));
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
		let hint = this.theme.fg("muted", " j/k move · enter inspect · space fold · / search · +/- zoom · g/G · q close");
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
			return [this.theme.fg("muted", this.store.records.length === 0 ? "  loading… or empty session" : "  nothing in zoom window (0 to reset)")];
		}
		// keep selection in view
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + height) this.scroll = this.selected - height + 1;

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
		const arrow = open ? "▼" : "▶";
		return (
			this.theme.fg("accent", `${arrow} turn ${turn}`) +
			this.theme.fg("muted", ` · ${ts} · ${tokens} tok${open ? "" : ` · ${count} records`}`)
		);
	}

	private renderRecord(index: number, width: number): string {
		const r = this.store.records[index]!;
		const time = this.theme.fg("dim", formatClock(r.ts));
		let body: string;
		switch (r.kind) {
			case "user":
				body = this.theme.fg("userMessageText", "● user      ") + clip(r.text, width - 26);
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
				body = this.theme.fg("text", "● assistant ") + clip(a.text, width - 26) + meta;
				break;
			}
			case "tool": {
				const t = r as ToolRecord;
				const icon =
					t.status === "ok"
						? this.theme.fg("success", "✓")
						: t.status === "error"
							? this.theme.fg("error", "✗")
							: t.status === "interrupted"
								? this.theme.fg("warning", "⏹")
								: this.theme.fg("warning", SPINNER[this.spinnerIdx % SPINNER.length]);
				body =
					this.theme.fg("toolTitle", `⚙ ${padVisible(t.name, 10)}`) +
					clip(t.argsSummary, width - 34) +
					` ${icon} ${this.theme.fg("dim", formatDuration(t.durationMs))}`;
				break;
			}
			case "compaction":
				body =
					this.theme.fg("warning", "◆ compaction ") +
					this.theme.fg("muted", clip(r.summary, width - 30)) +
					this.theme.fg("dim", ` (${formatTokens(r.tokensBefore)} tok before)`);
				break;
			case "marker":
				body = this.theme.fg("dim", `─ ${r.text}`);
				break;
		}
		return `  ${body} ${time}`;
	}

	/**
	 * Timeline strip (FR-6): one line, each column a time bucket.
	 * Assistant spans split TTFT (warning) vs decode (accent); tools ▂;
	 * user •; compaction ◆. Cursor column shows the selected record.
	 */
	private renderTimeline(width: number): string {
		const range = this.zoom ?? this.fullRange();
		if (!range || range.end - range.start < 1) return "";
		const cols = width - 2;
		const span = range.end - range.start;
		const cells: { ch: string; color: Parameters<Theme["fg"]>[0]; priority: number }[] = new Array(cols);
		const bucket = (ts: number) => Math.max(0, Math.min(cols - 1, Math.floor(((ts - range.start) / span) * cols)));
		const put = (ts0: number, ts1: number, ch: string, color: Parameters<Theme["fg"]>[0], priority: number) => {
			for (let c = bucket(ts0); c <= bucket(Math.max(ts1, ts0 + span / cols)); c++) {
				if (!cells[c] || cells[c].priority <= priority) cells[c] = { ch, color, priority };
			}
		};

		for (const r of this.store.records) {
			if (r.kind === "assistant") {
				const a = r as AssistantRecord;
				const end = a.ttftMs !== undefined ? a.ts + a.ttftMs + (a.decodeMs ?? 0) : a.ts;
				if (a.ttftMs !== undefined) {
					put(a.ts, a.ts + a.ttftMs, "█", "warning", 2);
					put(a.ts + a.ttftMs, end, "█", "accent", 2);
				} else {
					put(a.ts, end, "█", "accent", 2);
				}
			} else if (r.kind === "tool") {
				put(r.ts, r.ts + (r.durationMs ?? 0), "▂", r.status === "error" ? "error" : "muted", 3);
			} else if (r.kind === "user") {
				put(r.ts, r.ts, "•", "userMessageText", 1);
			} else if (r.kind === "compaction") {
				put(r.ts, r.ts, "◆", "warning", 4);
			}
		}

		let line = " ";
		for (let c = 0; c < cols; c++) {
			const cell = cells[c];
			line += cell ? this.theme.fg(cell.color, cell.ch) : this.theme.fg("borderMuted", "·");
		}
		// selected-record cursor on the timeline
		const selTs = this.selectedRecordTs();
		if (selTs !== undefined && selTs >= range.start && selTs <= range.end) {
			const c = bucket(selTs);
			line = replaceVisibleChar(line, 1 + c, this.theme.inverse("▐"));
		}
		const zoomTag = this.zoom ? this.theme.fg("warning", " zoomed (0 reset)") : "";
		return line + zoomTag;
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

/** Replace the n-th visible character of an ANSI-styled line. Best-effort: only safe for our own timeline line. */
function replaceVisibleChar(line: string, n: number, replacement: string): string {
	let visible = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i);
			i = end < 0 ? line.length : end + 1;
			continue;
		}
		if (visible === n) {
			// find end of this (possibly multi-byte) character
			const next = i + 1;
			return line.slice(0, i) + replacement + line.slice(next);
		}
		visible++;
		i++;
	}
	return line;
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
	const head = theme.bold(theme.fg("accent", ` ${r.kind} `)) + theme.fg("muted", formatClock(r.ts));
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
