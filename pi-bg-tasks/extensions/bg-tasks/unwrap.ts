/**
 * Undo the sandbox extension's command wrapping for DISPLAY purposes.
 *
 * The sandbox extension (tool_call input mutation) rewrites bash commands to
 * `env SANDBOX_RUNTIME=1 ... /usr/bin/sandbox-exec -p '<profile>' <shell> -c
 * '<original>'` before this extension's bash tool executes them. Execution
 * must use the wrapped form, but job.command feeds every display surface
 * (notifications, bg_list, bg_output, status pill) — showing the ~15 KB
 * wrapped blob there pollutes the conversation and leaks the per-session
 * proxy auth token into session logs.
 *
 * This module recovers the original command from the wrapped form so the
 * job registry can store the human-readable command. Detection is fully
 * structural and conservative: any deviation from the expected shape
 * returns the input unchanged (worst case = status quo display).
 *
 * The parse targets the exact quote() format of the pinned
 * @anthropic-ai/sandbox-runtime (bare words or single-quoted args, `'`
 * escaped as `'"'"'`, args joined with single spaces). Linux bubblewrap
 * wrapping has a different shape and is intentionally not unwrapped.
 */

/** Sentinel env assignment the runtime always injects first. */
const SANDBOX_MARKER = "SANDBOX_RUNTIME=1";
/** sandbox-exec binary the runtime invokes on macOS. */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Split a string produced by the runtime's quote() back into its argument
 * list. Returns null on any construct quote() never emits (double quotes,
 * backslashes, unbalanced quotes, consecutive spaces) — callers then treat
 * the command as not unwrappable.
 */
export function parseShellWords(s: string): string[] | null {
    const words: string[] = [];
    let cur = "";
    let inQuote = false;
    let started = false; // current word has begun (handles '' empty args)

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQuote) {
            if (c === "'") {
                // '"'"' = close quote, double-quoted literal ', reopen quote
                if (s.startsWith(`"'"'`, i + 1)) {
                    cur += "'";
                    i += 4; // consume the reopening quote; still inQuote
                } else {
                    inQuote = false;
                }
            } else {
                cur += c;
            }
            continue;
        }
        if (c === "'") {
            inQuote = true;
            started = true;
        } else if (c === '"') {
            return null; // quote() never emits double quotes
        } else if (c === " ") {
            if (started) {
                words.push(cur);
                cur = "";
                started = false;
            } else if (words.length > 0 && s[i - 1] === " ") {
                return null; // consecutive spaces: not quote() output
            }
        } else {
            cur += c;
            started = true;
        }
    }
    if (inQuote) return null; // unbalanced quote
    if (started) words.push(cur);
    return words;
}

/**
 * Recover the original command from a sandbox-runtime-wrapped command.
 * Returns the input unchanged when it is not (recognizably) wrapped.
 */
export function unwrapSandboxCommand(command: string): string {
    if (!command.startsWith("env ")) return command;
    if (!command.includes(SANDBOX_MARKER)) return command;
    if (!command.includes(SANDBOX_EXEC)) return command;

    const words = parseShellWords(command);
    if (!words || words.length < 5) return command;
    if (words[0] !== "env") return command;
    if (words[words.length - 2] !== "-c") return command;

    const execIdx = words.indexOf(SANDBOX_EXEC);
    if (execIdx === -1) return command;
    // Structure: env …vars… /usr/bin/sandbox-exec -p <profile> <shell> -c <cmd>
    if (words[execIdx + 1] !== "-p") return command;
    if (!words.slice(1, execIdx).includes(SANDBOX_MARKER)) return command;

    return words[words.length - 1];
}
