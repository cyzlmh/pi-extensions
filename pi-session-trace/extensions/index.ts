/** pi-session-trace — /trace: full-screen trajectory of the current session.
 *
 * Historical sessions are pi's job: /resume (or pi --resume) switches to an old
 * session, our session_start backfill reconstructs its full trajectory, and
 * /trace shows it. No private picker, no file scanning — dsh-style layering
 * where session selection lives outside the trajectory view.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LiveSource } from "./live.ts";
import { TraceStore } from "./store.ts";
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
		description: "Session trajectory — full-screen live trace of the current session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("trace: interactive TUI required", "warning");
				return;
			}
			const id = ctx.sessionManager.getSessionId();
			const project = ctx.cwd.split("/").pop() ?? ctx.cwd;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new TraceOverlay(tui, theme, liveStore, `live · ${project} · #${id.slice(0, 8)}`, done),
				OVERLAY_OPTS,
			);
		},
	});
}
