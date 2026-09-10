/**
 * Session bookmarks — browser-style favorites for pi sessions.
 *
 * Commands:
 *   /bookmarks [query]           open the bookmark picker; Enter resumes the
 *                                 selected session (cwd follows the session)
 *   /bookmark-add [name]         bookmark the current session under a name
 *                                 (falls back to session name / first message)
 *   /bookmark-remove             remove the current session's bookmark;
 *                                 silent no-op if not bookmarked
 *
 * Storage: ~/.pi/agent/session-bookmarks.json (honors PI_CODING_AGENT_DIR).
 * Bookmarks are global across projects. Session files are never modified.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Bookmark {
	id: string;
	file: string;
	/** User-given bookmark name. */
	name?: string;
	/** Session display name at bookmark time (fallback). */
	sessionName?: string;
	/** First user message preview (fallback for untitled sessions). */
	preview?: string;
	/** Session working directory at bookmark time. */
	cwd: string;
	addedAt: string;
}

interface Store {
	version: 1;
	bookmarks: Bookmark[];
}

const STORE_PATH = path.join(
	process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent"),
	"session-bookmarks.json",
);

// --- store ------------------------------------------------------------------

function loadStore(): Store {
	try {
		const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
		if (raw && Array.isArray(raw.bookmarks)) {
			// Legacy stores used "note" for the user-given name.
			for (const b of raw.bookmarks) {
				if (!b.name && b.note) b.name = b.note;
				delete b.note;
			}
			return { version: 1, bookmarks: raw.bookmarks };
		}
	} catch {
		// missing or corrupt — start fresh
	}
	return { version: 1, bookmarks: [] };
}

function saveStore(store: Store): void {
	fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
	fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// --- helpers ----------------------------------------------------------------

function tidyHome(p: string): string {
	if (!p) return "?";
	const home = os.homedir();
	if (p === home) return "~";
	return p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

function formatDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "?";
	return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
}

/** First user message, flattened to one line, for untitled sessions. */
function firstUserPreview(getEntries: () => Array<any>): string {
	for (const entry of getEntries()) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text = Array.isArray(content)
			? content
					.filter((p: any) => p?.type === "text")
					.map((p: any) => p.text ?? "")
					.join(" ")
			: String(content ?? "");
		const flat = text.replace(/\s+/g, " ").trim();
		if (flat) return flat.slice(0, 80);
	}
	return "";
}

function describe(b: Bookmark): string {
	const title = titleOf(b) || `(${b.id.slice(0, 8)})`;
	const where = tidyHome(b.cwd || path.dirname(path.dirname(b.file)));
	const missing = !fs.existsSync(b.file) ? " [missing]" : "";
	return `${title}  ·  ${where}  ·  ${formatDate(b.addedAt)}${missing}`;
}

/** Display title: user name > session name > first-message preview. */
function titleOf(b: Bookmark): string {
	return (b.name || b.sessionName || b.preview || "").trim();
}

function matches(b: Bookmark, query: string): boolean {
	if (!query) return true;
	return [b.name, b.sessionName, b.preview, b.cwd, b.file].some((field) =>
		(field || "").toLowerCase().includes(query),
	);
}

function findMine(store: Store, ctx: any): Bookmark | undefined {
	const id = ctx.sessionManager.getSessionId() as string;
	const file = ctx.sessionManager.getSessionFile() as string | undefined;
	return store.bookmarks.find((b) => b.id === id || (file && b.file === file));
}

function removeBookmark(store: Store, target: Bookmark): void {
	store.bookmarks = store.bookmarks.filter((b) => b !== target);
	saveStore(store);
}

// --- extension --------------------------------------------------------------

export default function sessionBookmarks(pi: ExtensionAPI): void {
	pi.registerCommand("bookmark-add", {
		description: "Bookmark the current session (/bookmark-add [name])",
		handler: async (args, ctx) => {
			const file = ctx.sessionManager.getSessionFile() as string | undefined;
			if (!file) {
				ctx.ui.notify("No session file to bookmark (ephemeral session?)", "warning");
				return;
			}
			const name = args.trim() || undefined;
			const store = loadStore();
			const existing = findMine(store, ctx);
			if (existing) {
				if (name) existing.name = name;
				existing.sessionName = ctx.sessionManager.getSessionName() ?? existing.sessionName;
				existing.preview =
					existing.preview || firstUserPreview(() => ctx.sessionManager.getEntries());
				saveStore(store);
				ctx.ui.notify(
					`Bookmark updated: ${titleOf(existing) || existing.id.slice(0, 8)}`,
					"info",
				);
				return;
			}
			const bookmark: Bookmark = {
				id: ctx.sessionManager.getSessionId(),
				file,
				name,
				sessionName: ctx.sessionManager.getSessionName() ?? undefined,
				preview: firstUserPreview(() => ctx.sessionManager.getEntries()),
				cwd: ctx.cwd,
				addedAt: new Date().toISOString(),
			};
			store.bookmarks.unshift(bookmark);
			saveStore(store);
			ctx.ui.notify(
				`Bookmarked: ${titleOf(bookmark) || bookmark.id.slice(0, 8)} (${store.bookmarks.length} total)`,
				"info",
				);
		},
	});

	pi.registerCommand("bookmarks", {
		description: "Open bookmarks and resume a session (/bookmarks [query])",
		handler: async (args, ctx) => {
			const query = args.trim().toLowerCase();
			const store = loadStore();
			const list = store.bookmarks.filter((b) => matches(b, query));
			if (list.length === 0) {
				ctx.ui.notify(
					query ? "No bookmarks match the query" : "No bookmarks yet — use /bookmark-add",
					"info",
				);
				return;
			}
			const labels = list.map((b, i) => `${i + 1}. ${describe(b)}`);
			const title = query ? `Bookmarks · "${args.trim()}":` : "Bookmarks:";
			const choice = await ctx.ui.select(title, labels);
			if (!choice) return;
			const bookmark = list[labels.indexOf(choice)];
			if (!bookmark) return;

			if (!fs.existsSync(bookmark.file)) {
				const remove = await ctx.ui.confirm("Session file is missing. Remove this bookmark?", bookmark.file);
				if (remove) {
					removeBookmark(store, bookmark);
					ctx.ui.notify("Bookmark removed", "info");
				}
				return;
			}

			const currentFile = ctx.sessionManager.getSessionFile() as string | undefined;
			if (currentFile && path.resolve(currentFile) === path.resolve(bookmark.file)) {
				ctx.ui.notify("Already in this session", "info");
				return;
			}

			const label = titleOf(bookmark) || bookmark.id.slice(0, 8);
			const result = await ctx.switchSession(bookmark.file, {
				withSession: (freshCtx) => {
					freshCtx.ui.notify(`Resumed: ${label}`, "info");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Switch cancelled", "warning");
			}
		},
	});

	pi.registerCommand("bookmark-remove", {
		description: "Remove the current session's bookmark (no-op if absent)",
		handler: async (_args, ctx) => {
			const store = loadStore();
			const mine = findMine(store, ctx);
			// Not bookmarked — silent no-op, like `rm` on a missing file.
			if (!mine) return;
			const label = titleOf(mine) || mine.id.slice(0, 8);
			removeBookmark(store, mine);
			ctx.ui.notify(`Removed: ${label}`, "info");
		},
	});
}
