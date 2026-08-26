/** TraceOverlay — main trajectory view: turn-grouped record list + inspector. */

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

const CHROME = 4; // title + separator + separator + hint line

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
			if (this.follow) this.selected = Math.max(0, this.rows.length - 1);
			this.scheduleRender();
			this.kickAnimation();
		});
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

	setNote(note: string): void {
		this.note = note;
		this.tui.requestRender();
	}

	// ------------------------------------------------------------------ rows

	private rebuildRows(): void {
		const rows: Row[] = [];
		const turns = this.store.turns();
		for (const turn of turns) {
			rows.push({ type: "header", turn });
			if (this.collapsed.has(turn)) continue;
			const range = this.store.turnRange(turn);
			if (!range) continue;
			for (let i = range.first; i <= range.last; i++) rows.push({ type: "record", index: i });
		}
		this.rows = rows;
		if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
	}

	// ------------------------------------------------------------------ input

	handleInput(data: string): void {
		if (this.inspector) {
			if (matchesKey(data, "escape") || data === "q") {
				this.inspector = null;
			} else if (matchesKey(data, "up") || data === "k") {
				this.inspector.scroll = Math.max(0, this.inspector.scroll - 1);
			} else if (matchesKey(data, "down") || data === "j") {
				this.inspector.scroll++;
			}
			this.tui.requestRender();
			return;
		}

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
		} else if (matchesKey(data, "space") || matchesKey(data, "return")) this.activate();
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

	// ------------------------------------------------------------------ render

	invalidate(): void {
		// theme changed — colors are re-read every render, nothing cached
	}

	render(width: number): string[] {
		const termRows = process.stdout.rows ?? 24;
		const bodyHeight = Math.max(4, Math.floor(termRows * 0.86) - CHROME);

		const title = this.theme.bold(this.theme.fg("accent", ` trace `)) +
			this.theme.fg("muted", `${this.title} · ${this.store.records.length} records`);
		const sep = this.theme.fg("borderMuted", "─".repeat(width));
		const newBelow = !this.follow && this.selected < this.rows.length - 1 ? this.rows.length - 1 - this.selected : 0;
		const hint = this.inspector
			? this.theme.fg("muted", " j/k scroll · esc back")
			: this.theme.fg("muted", " j/k move · enter inspect · space fold · g/G top/end · q close") +
				(newBelow > 0 ? this.theme.fg("warning", `  ↓ ${newBelow} new (G to follow)`) : "") +
				(this.note ? this.theme.fg("warning", `  ${this.note}`) : "");

		const body = this.inspector
			? this.renderInspector(width, bodyHeight)
			: this.renderList(width, bodyHeight);

		return [title, sep, ...body, sep, hint].map((l) => truncateToWidth(l, width));
	}

	private renderList(width: number, height: number): string[] {
		if (this.rows.length === 0) {
			return [this.theme.fg("muted", "  loading… or empty session")];
		}
		// keep selection in view
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + height) this.scroll = this.selected - height + 1;

		const out: string[] = [];
		for (let i = this.scroll; i < Math.min(this.rows.length, this.scroll + height); i++) {
			const row = this.rows[i]!;
			const line = row.type === "header" ? this.renderHeader(row.turn, width) : this.renderRecord(row.index, width);
			out.push(i === this.selected ? this.theme.bg("selectedBg", padVisible(line, width)) : line);
		}
		return out;
	}

	private renderHeader(turn: number, width: number): string {
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
						a.ttftMs !== undefined
							? ` TTFT ${formatDuration(a.ttftMs)} · decode ${formatDuration(a.decodeMs)}`
							: "";
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
