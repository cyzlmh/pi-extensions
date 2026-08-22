/**
 * Fork Pane Extension
 *
 * `/fork-pane` splits the current tmux window vertically and starts a
 * forked copy of the current pi session in the new pane.
 * `/fork-pane h` splits horizontally instead.
 *
 * Requires: running inside tmux, and a persisted (non-ephemeral) session.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fork-pane", {
		description: "Split tmux pane and fork this session into it (append 'h' for horizontal split)",
		handler: async (args, ctx) => {
			if (!process.env.TMUX) {
				ctx.ui.notify("fork-pane: not inside tmux", "error");
				return;
			}

			const file = ctx.sessionManager.getSessionFile();
			if (!file) {
				ctx.ui.notify("fork-pane: ephemeral session, nothing to fork", "error");
				return;
			}

			const dir = args.trim() === "h" ? "-h" : "-v";
			const cmd = `pi --fork ${shellQuote(file)}`;
			const result = spawnSync("tmux", ["split-window", dir, "-c", ctx.cwd, cmd]);

			if (result.status !== 0) {
				const stderr = result.stderr?.toString().trim();
				ctx.ui.notify(`fork-pane: tmux split-window failed${stderr ? `: ${stderr}` : ""}`, "error");
			}
		},
	});
}
