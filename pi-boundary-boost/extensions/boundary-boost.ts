/**
 * Boundary Boost — rank direct directory children first in `@` completion.
 *
 * Shortcut: any `@<dir>/<prefix>` query reads `<dir>` directly via readdir
 * and ranks its direct children matching `prefix` first, then merges the
 * built-in fd fuzzy results (deduplicated) after them.
 *
 * Why: the built-in `@` completion always routes to fd fuzzy search
 * (`getFuzzyFileSuggestions`). fd runs with `--hidden --max-results 100`,
 * so for a query like `@~/workdir/pro` the result set floods with deep
 * nested matches (e.g. `jupyter/venv/.../site-packages/profile/`), and the
 * direct child can be cut by the 100-result cap before scoring even runs.
 * Reading the scoped directory directly guarantees direct children appear,
 * while merged fd results preserve deep fuzzy search.
 *
 * At the home root (`@~/<prefix>`) known noise dirs (`.cache`, `.claude`,
 * `.codeium`, ...) are filtered out unless they themselves match the prefix.
 *
 * Queries without a `/` (bare fuzzy like `@foo`) and non-`@` queries pass
 * through to the built-in provider unchanged.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
} from "@earendil-works/pi-tui";

const HOME_NOISE_DIRS = new Set([
	".cache",
	".claude",
	".codeium",
	".config",
	".dotnet",
	".npm",
	".nvm",
	".vscode-server",
	".local",
	".cargo",
	".rustup",
	".ssh",
	".Trash",
]);

function extractAtQuery(text: string): string | null {
	const quoted = text.match(/(?:^|\s)@"([^"]*)$/);
	if (quoted) return quoted[1] ?? "";
	const bare = text.match(/(?:^|\s)@([^\s]*)$/);
	if (!bare) return null;
	const raw = bare[1] ?? "";
	return raw.replace(/^[`"'([{<]+/, "").replace(/[)\]}>.,;:!?"'`]+$/, "");
}

async function readdirScoped(
	dirPart: string,
	prefix: string,
	cwd: string,
): Promise<AutocompleteItem[] | null> {
	// Resolve dirPart (display form, with trailing /) to an absolute path.
	let absDir: string;
	if (dirPart === "~/" || dirPart === "~") {
		absDir = homedir();
	} else if (dirPart.startsWith("~/")) {
		absDir = join(homedir(), dirPart.slice(2));
	} else if (dirPart.startsWith("/")) {
		absDir = dirPart;
	} else {
		absDir = join(cwd, dirPart);
	}

	let entries;
	try {
		entries = await readdir(absDir, { withFileTypes: true });
	} catch {
		return null;
	}

	const isHomeRoot = dirPart === "~/" || dirPart === "~";
	const lowerPrefix = prefix.toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const entry of entries) {
		const name = entry.name;
		const isDir = entry.isDirectory();
		// At home root, skip known noise dirs unless they match the prefix.
		if (
			isHomeRoot &&
			isDir &&
			name.startsWith(".") &&
			HOME_NOISE_DIRS.has(name) &&
			!name.slice(1).toLowerCase().startsWith(lowerPrefix)
		) {
			continue;
		}
		if (prefix && !name.toLowerCase().startsWith(lowerPrefix)) {
			continue;
		}
		items.push({
			value: `${dirPart}${name}${isDir ? "/" : ""}`,
			label: name + (isDir ? "/" : ""),
		});
	}
	// Directories first, then alphabetical — matches built-in getFileSuggestions.
	items.sort((a, b) => {
		const aDir = a.value.endsWith("/");
		const bDir = b.value.endsWith("/");
		if (aDir !== bDir) return aDir ? -1 : 1;
		return a.label.localeCompare(b.label);
	});
	return items;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const cwd = ctx.cwd;
		ctx.ui.addAutocompleteProvider(
			(current: AutocompleteProvider): AutocompleteProvider => ({
				// Note: cannot use `...current` here. Class methods like
				// `applyCompletion` live on the prototype and are NOT picked up
				// by object spread — only own enumerable properties are. Missing
				// them crashes the editor on Tab/Enter. Forward each method
				// explicitly instead.
				triggerCharacters: current.triggerCharacters,
				async getSuggestions(lines, l, c, opts) {
					const text = (lines[l] ?? "").slice(0, c);
					const quoted = /(?:^|\s)@"[^"]*$/.test(text);
					const q = extractAtQuery(text);

					// @<dir>/<prefix>: direct children (readdir) first, fd fuzzy merged after.
					if (q !== null && q.includes("/")) {
						const lastSlash = q.lastIndexOf("/");
						const dirPart = q.slice(0, lastSlash + 1);
						const prefix = q.slice(lastSlash + 1);
						const [direct, base] = await Promise.all([
							readdirScoped(dirPart, prefix, cwd),
							current.getSuggestions(lines, l, c, opts),
						]);
						if (!direct || direct.length === 0) {
							return base; // fall back to built-in (may be null)
						}
						// Align with built-in value format: @-prefixed, quoted when the
						// user typed @" or the path contains a space.
						const items = direct.map((item) => {
							const p = item.value;
							const value = quoted || p.includes(" ") ? `@"${p}"` : `@${p}`;
							return { ...item, value };
						});
						// Merge recursive fd results after direct children, deduped by value.
						const seen = new Set(items.map((i) => i.value.toLowerCase()));
						for (const item of base?.items ?? []) {
							if (!seen.has(item.value.toLowerCase())) {
								seen.add(item.value.toLowerCase());
								items.push(item);
							}
						}
						return { items, prefix: quoted ? `@"${q}` : `@${q}` };
					}

					return current.getSuggestions(lines, l, c, opts);
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					return current.applyCompletion(
						lines,
						cursorLine,
						cursorCol,
						item,
						prefix,
					);
				},
				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
					return (
						current.shouldTriggerFileCompletion?.(
							lines,
							cursorLine,
							cursorCol,
						) ?? true
					);
				},
			}),
		);
	});
}