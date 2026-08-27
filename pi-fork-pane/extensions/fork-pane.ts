/**
 * Fork Pane Extension
 *
 * `/fork-pane` splits the current tmux window vertically and starts a
 * forked copy of the current pi session in the new pane.
 * `/fork-pane h` splits horizontally instead.
 *
 * `/tree-pane` opens the session tree selector (same UI as `/tree`);
 * instead of switching in place, the picked entry is forked into a new
 * tmux pane, leaving the current session untouched.
 *
 * Requires: running inside tmux, and a persisted (non-ephemeral) session.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shared guards: tmux + persisted session. Returns the session file or null (after notifying). */
function requireTmuxSession(ctx: ExtensionCommandContext, cmdName: string): string | null {
	if (!process.env.TMUX) {
		ctx.ui.notify(`${cmdName}: not inside tmux`, "error");
		return null;
	}
	const file = ctx.sessionManager.getSessionFile();
	if (!file) {
		ctx.ui.notify(`${cmdName}: ephemeral session, nothing to fork`, "error");
		return null;
	}
	return file;
}

function splitPane(ctx: ExtensionCommandContext, args: string, cmdName: string, shellCmd: string): void {
	const dir = args.trim() === "h" ? "-h" : "-v";
	const result = spawnSync("tmux", ["split-window", dir, "-c", ctx.cwd, shellCmd]);
	if (result.status !== 0) {
		const stderr = result.stderr?.toString().trim();
		ctx.ui.notify(`${cmdName}: tmux split-window failed${stderr ? `: ${stderr}` : ""}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fork-pane", {
		description: "Split tmux pane and fork this session into it (append 'h' for horizontal split)",
		handler: async (args, ctx) => {
			const file = requireTmuxSession(ctx, "fork-pane");
			if (!file) return;
			splitPane(ctx, args, "fork-pane", `pi --fork ${shellQuote(file)}`);
		},
	});

	pi.registerCommand("tree-pane", {
		description: "Fork a picked session-tree point into a new tmux pane (append 'h' for horizontal split)",
		handler: async (args, ctx) => {
			const file = requireTmuxSession(ctx, "tree-pane");
			if (!file) return;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("tree-pane: requires interactive mode", "error");
				return;
			}

			const entryId = await ctx.ui.custom<string | null>(
				(_tui, _theme, _kb, done) =>
					new TreeSelectorComponent(
						ctx.sessionManager.getTree(),
						ctx.sessionManager.getLeafId(),
						process.stdout.rows ?? 24,
						(id) => done(id),
						() => done(null),
					),
				{ overlay: true },
			);
			if (!entryId) return;

			// Write a new session file containing only root→entry, without touching this session.
			const newFile = SessionManager.open(file).createBranchedSession(entryId);
			if (!newFile) {
				ctx.ui.notify("tree-pane: failed to create branched session file", "error");
				return;
			}

			splitPane(ctx, args, "tree-pane", `pi --session ${shellQuote(newFile)}`);
		},
	});
}
