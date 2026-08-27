/** pi-session-trace — /trace command entry. Live view by default, replay on demand. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LiveSource } from "./live.ts";
import { listSessions, type SessionInfo, streamSession } from "./replay.ts";
import { TraceStore } from "./store.ts";
import { SessionPicker } from "./ui/session-picker.ts";
import { TraceOverlay } from "./ui/trace-overlay.ts";

// Full-screen takeover: pi-tui composites overlays onto terminal lines with no
// added chrome, so 100%×100% + a body padded to terminal height = a dedicated
// screen (chat behind is fully covered), esc/q returns to chat.
const OVERLAY_OPTS = { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } } as const;

export default function sessionTrace(pi: ExtensionAPI) {
	// Live collection starts at extension load, so /trace is complete whenever opened.
	const liveStore = new TraceStore();
	new LiveSource(liveStore).attach(pi);

	pi.registerCommand("trace", {
		description: "Session trajectory — /trace (live) · /trace pick (history) · /trace <id> (replay one)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("trace: interactive TUI required", "warning");
				return;
			}
			try {
				await handleTrace(args.trim(), ctx, liveStore);
			} catch (err) {
				ctx.ui.notify(`trace: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

async function handleTrace(args: string, ctx: ExtensionCommandContext, liveStore: TraceStore): Promise<void> {
	// Default: live view of the current session.
	if (!args) {
		const id = ctx.sessionManager.getSessionId();
		const project = ctx.cwd.split("/").pop() ?? ctx.cwd;
		await openOverlay(ctx, liveStore, `live · ${project} · #${id.slice(0, 8)}`);
		return;
	}

	const sessions = await listSessions();
	if (args !== "pick") {
		// /trace <id-prefix> — open one historical session directly.
		const target = sessions.find((s) => s.sessionId.startsWith(args) || s.file.includes(args));
		if (!target) {
			ctx.ui.notify(`trace: no session matching "${args}" (try /trace pick)`, "warning");
			return;
		}
		await openReplay(target, ctx);
		return;
	}

	if (sessions.length === 0) {
		ctx.ui.notify("trace: no sessions found under ~/.pi/agent/sessions", "warning");
		return;
	}
	const picked = await ctx.ui.custom<SessionInfo | null>(
		(tui, theme, _kb, done) => new SessionPicker(tui, theme, sessions, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "70%" } },
	);
	if (picked) await openReplay(picked, ctx);
}

function openOverlay(ctx: ExtensionCommandContext, store: TraceStore, title: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => new TraceOverlay(tui, theme, store, title, done), OVERLAY_OPTS);
}

async function openReplay(session: SessionInfo, ctx: ExtensionCommandContext): Promise<void> {
	const store = new TraceStore();
	const title = `replay · ${session.project} · #${session.sessionId.slice(0, 8)}`;
	// Open the overlay first so records stream in visibly (E2).
	const overlayDone = openOverlay(ctx, store, title);
	const result = await streamSession(session.file, (batch) => store.appendMany(batch));
	if (result.badLines > 0) ctx.ui.notify(`trace: skipped ${result.badLines} corrupted line(s)`, "warning");
	await overlayDone;
}
