/** pi-session-trace — /trace command entry. M1: replay mode (historical sessions). */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listSessions, type SessionInfo, streamSession } from "./replay.ts";
import { TraceStore } from "./store.ts";
import { SessionPicker } from "./ui/session-picker.ts";
import { TraceOverlay } from "./ui/trace-overlay.ts";

export default function sessionTrace(pi: ExtensionAPI) {
	pi.registerCommand("trace", {
		description: "Open the session trajectory viewer (replay of any session; live view coming in M2).",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				await handleTrace(args.trim(), ctx);
			} catch (err) {
				ctx.ui.notify(`trace: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

async function handleTrace(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sessions = await listSessions();
	if (sessions.length === 0) {
		ctx.ui.notify("trace: no sessions found under ~/.pi/agent/sessions", "warning");
		return;
	}

	let target: SessionInfo | null | undefined;
	if (args) {
		target = sessions.find((s) => s.sessionId.startsWith(args) || s.file.includes(args));
		if (!target) {
			ctx.ui.notify(`trace: no session matching "${args}"`, "warning");
			return;
		}
	} else {
		target = await ctx.ui.custom<SessionInfo | null>(
			(tui, theme, _kb, done) => new SessionPicker(tui, theme, sessions, done),
			{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "70%" } },
		);
		if (!target) return; // cancelled
	}

	await openReplay(target, ctx);
}

async function openReplay(session: SessionInfo, ctx: ExtensionCommandContext): Promise<void> {
	const store = new TraceStore();
	const title = `replay · ${session.project} · #${session.sessionId.slice(0, 8)}`;

	// Open the overlay first so records stream in visibly (E2).
	const overlayDone = ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new TraceOverlay(tui, theme, store, title, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "86%" } },
	);

	// TODO(M1 follow-up): surface badLines in the overlay note once the parse finishes.
	// The overlay component is created inside ctx.ui.custom; streaming runs concurrently.
	await streamSession(session.file, (batch) => store.appendMany(batch));
	await overlayDone;
}
