/**
 * bg-tasks — background bash tasks for pi.
 *
 * Registers four tools:
 *   - bash (override — adds run_in_background, auto-backgrounds at timeout)
 *   - bg_list / bg_output / bg_stop
 *
 * Plus the Ctrl+Shift+B shortcut, /bg and /bg-tasks commands, the
 * <task-notification> message renderer, the steer auto-background hook,
 * and session lifecycle hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BgRegistry, sweepStaleLogs } from "./registry.ts";
import { detectNonInteractive, terminateJobSilently } from "./lifecycle.ts";
import { registerBashTool } from "./tools-bash.ts";
import { registerTaskTools } from "./tools-tasks.ts";
import { registerUi } from "./ui.ts";

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BgRegistry();

    // ── Tool registration ─────────────────────────────────────────
    // Use the unwrapped tool *definition* so the override inherits pi's
    // native bash renderCall/renderResult (createBashTool returns a wrapped
    // AgentTool that drops them). pi's registry is a Map.set where later
    // registration with the same name overrides the built-in.
    const originalBash = createBashToolDefinition(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerTaskTools(pi, reg);

    // ── Commands / shortcut / message renderer ────────────────────
    registerUi(pi, reg);

    // ── Steering interrupt ────────────────────────────────────────
    // pi queues a mid-stream steering message and delivers it only after
    // the current tool calls finish — a long foreground command would lock
    // the user out until it completes or hits the auto-background timeout.
    // Background it the moment the user steers instead: the command keeps
    // running, the bash tool returns, and the steering message is
    // delivered at the natural turn boundary. Deliberately NOT ctx.abort()
    // (abort kills the process and restores the queued message to the
    // editor — the data-loss the foreground path is built to avoid).
    pi.on("input", (event) => {
        if (event.streamingBehavior !== "steer") return;
        if (reg.foreground.size === 0) return;
        for (const slot of reg.foreground.values()) {
            slot.requestPause("steer");
        }
        reg.foreground.clear();
    });

    // ── Session start ─────────────────────────────────────────────
    pi.on("session_start", async () => {
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );
        // Housekeeping: drop logs from previous sessions older than 24h.
        sweepStaleLogs();
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async () => {
        // Kill ALL running tasks on ANY shutdown reason, so no orphans
        // outlive the session. The silent-kill path latches `notified`, so
        // no <task-notification> fires on the way out. Log files are left
        // for the next session's stale sweep.
        const kills: Promise<void>[] = [];
        for (const job of reg.jobs.values()) {
            if (job.status === "running") {
                kills.push(terminateJobSilently(reg, job, "session_shutdown"));
            }
        }
        // Bounded by the SIGTERM grace window (kills run in parallel).
        await Promise.all(kills);
    });
}
