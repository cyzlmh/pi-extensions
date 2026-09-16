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
 * Startup CLI flags of the current pi process (model, tools, extensions,
 * --no-sandbox, ...) are forwarded to the new pane, except session
 * selection flags and one-shot actions, which the pane supplies itself.
 *
 * Requires: running inside tmux, and a persisted (non-ephemeral) session.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Boolean flags that must not re-run in the pane (session selection is passed explicitly, one-shot actions already happened). */
const DROP_FLAGS = new Set([
	"-c", "--continue",
	"-r", "--resume",
	"-p", "--print",
	"--no-session",
	"-h", "--help",
	"-v", "--version",
	"--list-models",
	"--export",
]);

/** Flags whose value must be dropped together with the flag. */
const DROP_VALUE_FLAGS = new Set(["--session", "--fork", "--name", "-n"]);

/** Known flags that take a separate value (long and short forms) — the value must travel with its flag. */
const VALUE_FLAGS = new Set([
	"--model", "--provider", "--thinking", "--models", "--api-key",
	"--tools", "-t", "--exclude-tools", "-xt", "--extension", "-e",
	"--skill", "--prompt-template", "--theme", "--use-theme",
	"--system-prompt", "--append-system-prompt", "--tui-mode", "--session-dir",
]);

/** Known boolean flags we forward as-is (so a following word is not mistaken for their value). */
const KEEP_BOOL_FLAGS = new Set([
	"--verbose", "-a", "--approve", "-na", "--no-approve", "--offline",
	"-nc", "--no-context-files", "-nt", "--no-tools", "-nbt", "--no-builtin-tools",
	"--no-extensions", "--no-skills", "--no-themes", "--no-prompt-templates",
]);

/**
 * Rebuild the startup flags of this pi process so the forked pane inherits them.
 * Session-selection flags, one-shot actions, initial prompts and @file args are
 * dropped; everything else (including unknown flags such as --no-sandbox on
 * builds that support it) is forwarded verbatim.
 *
 * Unknown long flags follow pi's own parse rule: `--flag value` consumes the
 * value (unless it starts with - or @), otherwise the flag is boolean.
 */
export function inheritedFlags(argv: string[] = process.argv.slice(2)): string[] {
	const raw = argv;
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const tok = raw[i];
		if (tok === "--") break; // everything after -- is the initial prompt
		if (!tok.startsWith("-")) continue; // positional prompt or @file
		const eq = tok.indexOf("=");
		const head = eq === -1 ? tok : tok.slice(0, eq);
		if (DROP_VALUE_FLAGS.has(head)) {
			if (eq === -1) i++; // skip the flag's value too
			continue;
		}
		if (DROP_FLAGS.has(head)) continue;
		out.push(tok);
		if (eq !== -1) continue; // --flag=value is self-contained
		// Keep the flag's value with it: known value-taking flags, and unknown
		// long flags that consume one (mirroring pi's argument parser).
		const next = raw[i + 1];
		const takesValue =
			VALUE_FLAGS.has(head) ||
			(!KEEP_BOOL_FLAGS.has(head) &&
				head.startsWith("--") &&
				next !== undefined &&
				!next.startsWith("-") &&
				!next.startsWith("@"));
		if (takesValue && i + 1 < raw.length) out.push(raw[++i]);
	}
	return out;
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

function paneCommand(sessionFlag: string): string {
	const flags = inheritedFlags().map(shellQuote).join(" ");
	return `pi ${flags} ${sessionFlag}`.replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fork-pane", {
		description: "Split tmux pane and fork this session into it (append 'h' for horizontal split)",
		handler: async (args, ctx) => {
			const file = requireTmuxSession(ctx, "fork-pane");
			if (!file) return;
			splitPane(ctx, args, "fork-pane", paneCommand(`--fork ${shellQuote(file)}`));
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

			splitPane(ctx, args, "tree-pane", paneCommand(`--session ${shellQuote(newFile)}`));
		},
	});
}
