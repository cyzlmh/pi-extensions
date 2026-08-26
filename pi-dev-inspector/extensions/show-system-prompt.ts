/**
 * Show System Prompt Extension
 *
 *   /system-prompt   Print the current session's system prompt into the TUI.
 *                    Sections are styled for easier visual scanning:
 *                      • Section headers (role preamble, Available tools,
 *                        Guidelines, Pi documentation, append intro, project
 *                        context intro, skills intro, etc.) — bold + accent
 *                      • Bullet markers (- ) — dim
 *                      • XML wrappers (<project_context>, <skill>, …) — muted
 *                      • Skill <name>/<description>/<location> values — accent
 *                      • "Current date" / "Current working directory" — dim
 *                    Press Esc (or q) to close.
 *
 * Captures the prompt via `before_agent_start` (post-chained, i.e. what is
 * actually sent to the LLM). Falls back to live `ctx.getSystemPrompt()` if
 * invoked before any turn has run in this session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Theme = { fg: (color: string, text: string) => string };

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

function bold(s: string): string {
	return `${BOLD}${s}${UNBOLD}`;
}

// Lines that introduce a section in the assembled prompt.
const SECTION_HEADER_PATTERNS: RegExp[] = [
	/^You are an expert/i,
	/^Available tools:$/,
	/^In addition to the tools above/i,
	/^Guidelines:$/,
	/^Pi documentation/i,
	/^Project-specific instructions/i,
	/^The following skills/i,
	/^Use the read tool to load a skill/i,
	/^When a skill file references/i,
];

// Lines where the *content* between XML tags is worth highlighting.
const XML_VALUE_TAGS = new Set(["name", "description", "location"]);

/**
 * Style a single line. The colored string may contain ANSI escapes;
 * `wrapTextWithAnsi` preserves them across line wraps.
 */
function styleLine(line: string, theme: Theme): string {
	const trimmed = line.trim();
	if (!trimmed) return line;

	const dim = (s: string) => theme.fg("dim", s);
	const accent = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);

	// Line is entirely an XML tag (with optional attributes): <foo>, </foo>,
	// <foo attr="…">, etc.
	if (/^<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>$/.test(trimmed)) {
		return muted(line);
	}

	// Line contains XML mixed with content (e.g. "    <name>foo</name>",
	// or "<project_instructions path="…">").
	if (line.includes("<") && line.includes(">")) {
		return line.replace(
			/<[^>]+>|[^<]+/g,
			(match) => {
				if (!match.startsWith("<")) return match;
				// Highlight values of known skill-metadata tags.
				for (const tag of XML_VALUE_TAGS) {
					const open = `<${tag}>`;
					const close = `</${tag}>`;
					if (match === open || match === close) return muted(match);
				}
				return muted(match);
			},
		);
	}

	// Section headers
	for (const pat of SECTION_HEADER_PATTERNS) {
		if (pat.test(trimmed)) return bold(accent(line));
	}

	// Bulleted list items: dim the "- " marker, leave content normal.
	if (/^- /.test(line)) {
		return dim("- ") + line.slice(2);
	}

	// Meta lines
	if (/^Current (date|working directory):/.test(trimmed)) {
		return dim(line);
	}

	return line;
}

/**
 * Apply section styling to the whole prompt. The returned string contains
 * ANSI color codes; wrap with `wrapTextWithAnsi` to honor terminal width
 * while preserving the styling across line wraps.
 */
function stylePrompt(prompt: string, theme: Theme): string {
	return prompt
		.split("\n")
		.map((line) => styleLine(line, theme))
		.join("\n")
		// Ensure every styled run is properly closed before each newline so
		// styles don't leak into the next line.
		.replace(/(\x1b\[[0-9;]*m)(?!\x1b\[0m)/g, "$1")
		.concat("");
}

// Append a reset at the very end so any trailing styled segment doesn't
// bleed into the caller's prompt after the overlay closes.
function withTrailingReset(s: string): string {
	return s.endsWith(RESET) ? s : s + RESET;
}

export default function (pi: ExtensionAPI) {
	let lastPrompt: string | undefined;

	pi.on("before_agent_start", (event) => {
		lastPrompt = event.systemPrompt;
	});

	pi.registerCommand("system-prompt", {
		description: "Print the current session's system prompt",
		handler: async (_args, ctx) => {
			const prompt = lastPrompt ?? ctx.getSystemPrompt();

			if (ctx.mode !== "tui") {
				ctx.ui.notify(prompt, "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				let cachedWidth = 0;
				let cachedLines: string[] = [];

				return {
					render(width: number): string[] {
						if (width !== cachedWidth) {
							cachedWidth = width;
							const styled = withTrailingReset(stylePrompt(prompt, theme));
							cachedLines = wrapTextWithAnsi(styled, width);
						}
						return cachedLines;
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || data === "q") {
							done();
						}
					},
					invalidate(): void {
						cachedWidth = 0;
					},
				};
			});
		},
	});
}