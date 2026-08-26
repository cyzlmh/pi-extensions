/** SessionPicker — fuzzy-ish filter + list of historical sessions. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../replay.ts";
import { formatRelative } from "../types.ts";

const CHROME = 5; // title + query + separator + separator + hint

export class SessionPicker implements Component {
	private query = "";
	private filtered: SessionInfo[];
	private selected = 0;
	private scroll = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private sessions: SessionInfo[],
		private done: (pick: SessionInfo | null) => void,
	) {
		this.filtered = sessions;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(this.filtered[this.selected] ?? null);
			return;
		}
		if (matchesKey(data, "up")) this.select(this.selected - 1);
		else if (matchesKey(data, "down")) this.select(this.selected + 1);
		else if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.refilter();
		} else if (data.length === 1 && data >= " ") {
			this.query += data;
			this.refilter();
		}
		this.tui.requestRender();
	}

	private refilter(): void {
		const q = this.query.toLowerCase();
		this.filtered = q
			? this.sessions.filter((s) => `${s.project} ${s.preview} ${s.sessionId}`.toLowerCase().includes(q))
			: this.sessions;
		this.selected = 0;
		this.scroll = 0;
	}

	private select(idx: number): void {
		this.selected = Math.max(0, Math.min(this.filtered.length - 1, idx));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const termRows = process.stdout.rows ?? 24;
		const bodyHeight = Math.max(4, Math.floor(termRows * 0.7) - CHROME);

		const title = this.theme.bold(this.theme.fg("accent", " trace ")) +
			this.theme.fg("muted", `pick a session · ${this.sessions.length} total`);
		const queryLine = this.theme.fg("text", ` › ${this.query}`) + this.theme.fg("muted", "█");
		const sep = this.theme.fg("borderMuted", "─".repeat(width));
		const hint = this.theme.fg("muted", " type to filter · ↑↓ move · enter open · esc cancel");

		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + bodyHeight) this.scroll = this.selected - bodyHeight + 1;

		const body: string[] = [];
		for (let i = this.scroll; i < Math.min(this.filtered.length, this.scroll + bodyHeight); i++) {
			const s = this.filtered[i]!;
			const line =
				this.theme.fg("dim", ` ${formatRelative(s.mtimeMs).padEnd(9)}`) +
				this.theme.fg("accent", ` ${s.project.slice(0, 18).padEnd(18)}`) +
				this.theme.fg("text", ` ${clip(s.preview, width - 46)}`) +
				this.theme.fg("dim", ` #${s.sessionId.slice(0, 8)}`);
			body.push(i === this.selected ? this.theme.bg("selectedBg", padVisible(line, width)) : line);
		}
		if (body.length === 0) body.push(this.theme.fg("muted", "  no matching sessions"));

		return [title, queryLine, sep, ...body, sep, hint].map((l) => truncateToWidth(l, width));
	}
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function padVisible(s: string, width: number): string {
	const w = visibleWidth(s);
	return w >= width ? s : s + " ".repeat(width - w);
}
