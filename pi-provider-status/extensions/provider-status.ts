/**
 * Provider Status Extension
 *
 *   /status   Query remaining quota / balance for providers that expose a
 *             Bearer-token status endpoint, and print a combined report.
 *
 *             The FAMILIES table below is a fixed list of provider ids. A
 *             provider is reported only when an API key is configured for
 *             it (resolved via ctx.modelRegistry.getApiKeyForProvider());
 *             anything else — including built-in registry providers without
 *             a key — never appears. To support a new provider, add one
 *             FAMILIES entry.
 *
 *             Multiple API keys for one provider (e.g. several Kimi
 *             accounts) can be reported as one section per key: point
 *             $KIMI_SWITCH_STORE at a directory of <name>.auth.json files
 *             ({"key": "sk-..."}) and each becomes a "Kimi slot" section;
 *             the slot matching the live registry key is marked (active).
 *
 *             The official kimi-code CLI's OAuth account (~/.kimi-code) is
 *             reported as "Kimi cli account"; its token is refreshed through
 *             the CLI's own OAuth flow when close to expiry (the rotated
 *             pair is written back, like the CLI itself would).
 *
 *             Claude Code accounts saved by the CLI are reported as
 *             "Claude account" when its credentials exist
 *             (~/.claude/.credentials.json, or the macOS Keychain). Claude
 *             tokens are used strictly read-only — an expired access token
 *             is reported as an error, never refreshed (re-login with the
 *             claude CLI to renew). The "Codex account" section uses pi's
 *             own ChatGPT OAuth login (/login → ChatGPT Codex) via the
 *             model registry, so pi refreshes the token.
 *
 *             Sections render in a fixed order — pay-as-you-go balances,
 *             then subscription plans, then kimi accounts — via the
 *             order field on each FAMILIES entry / section.
 *
 *             The panel opens immediately; each section fills in as its
 *             request settles. Press r to refresh, Esc (or q) to close.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// ─── Rendering model ────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "error";
type StyleColor = Tone | "muted" | "accent";

/** One rendered line of a section: label + optional bar/value + dim hint. */
interface Row {
	label: string;
	text?: string;
	/** 0–100 remaining; renders a bar (aligned with the timeline) colored by usageTone(). */
	percentLeft?: number;
	/** Suppress the bar for plain balances where a quota bar makes no sense. */
	hideBar?: boolean;
	/** Explicit row color (probe results, errors); default is plain text. */
	tone?: Tone;
	/** Secondary dim text, e.g. "resets Fri 00:00". */
	hint?: string;
	/** Quota window bounds; renders a timeline line under the row. */
	timeline?: { startMs: number; endMs: number };
}

/** Minimal styling surface so TUI (theme) and pipe mode (ANSI) share rendering. */
interface Styler {
	bold(s: string): string;
	dim(s: string): string;
	tone(color: StyleColor, s: string): string;
}

const ANSI_COLORS: Record<StyleColor, string> = { ok: "32", warn: "33", error: "31", muted: "2", accent: "36" };

const ansiStyler: Styler = {
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	dim: (s) => `\x1b[2m${s}\x1b[22m`,
	tone: (c, s) => `\x1b[${ANSI_COLORS[c]}m${s}\x1b[0m`,
};

/** Percent-left color: red ≤ 5, yellow ≤ 20, green < 90, accent ≥ 90. */
function percentTone(pctLeft: number): StyleColor {
	return pctLeft <= 5 ? "error" : pctLeft <= 20 ? "warn" : pctLeft < 90 ? "ok" : "accent";
}

/** Accepts both numbers and numeric strings (kimi serializes quotas as strings). */
function toNum(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

/** "3d 2h" / "5h 12m" / "45m" for timeline annotations. */
function humanDuration(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60000));
	const d = Math.floor(m / 1440);
	const h = Math.floor((m % 1440) / 60);
	return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/** Window length from a kimi window spec, e.g. {duration: 300, timeUnit: "TIME_UNIT_MINUTE"}. */
function kimiWindowMs(w: any): number | undefined {
	const n = toNum(w?.duration);
	const u = String(w?.timeUnit ?? "");
	if (n === undefined) return undefined;
	if (u.endsWith("MINUTE")) return n * 60e3;
	if (u.endsWith("HOUR")) return n * 3600e3;
	if (u.endsWith("DAY")) return n * 86400e3;
	if (u.endsWith("SECOND")) return n * 1e3;
	return undefined;
}

/**
 * Canonical quota row: percentage + "used/limit" + dim reset hint, so
 * every provider's quota lines look the same. usedPct is for APIs (zai)
 * that report only "% used + absolute remaining" — the limit is derived.
 * pctLeft is an API-reported remaining percent used when the absolute
 * counts are missing or zero (minimax). windowMs + reset add a timeline.
 */
function quotaRow(
	label: string,
	o: {
		remaining?: unknown;
		limit?: unknown;
		usedPct?: unknown;
		pctLeft?: unknown;
		reset?: unknown;
		windowMs?: number;
		hideBar?: boolean;
		format?: (n: number) => string;
	},
): Row {
	const f = o.format ?? ((n: number) => String(n));
	const remaining = toNum(o.remaining);
	let limit = toNum(o.limit);
	const usedPct = toNum(o.usedPct);
	if (limit === undefined && remaining !== undefined && usedPct !== undefined && usedPct < 100) {
		limit = Math.round(remaining / (1 - usedPct / 100));
	}
	const hasCounts = remaining !== undefined && limit !== undefined && limit > 0;
	const resetMs =
		typeof o.reset === "string" || typeof o.reset === "number" ? new Date(o.reset).getTime() : NaN;
	// With a timeline the reset time moves to the timeline line; no hint needed.
	const timeline =
		o.windowMs !== undefined && Number.isFinite(resetMs)
			? { startMs: resetMs - o.windowMs, endMs: resetMs }
			: undefined;
	return {
		label,
		text: hasCounts ? `${f(limit! - remaining!)}/${f(limit!)}`
			: remaining !== undefined && limit === undefined ? `${f(remaining)} left`
			: undefined,
		percentLeft: hasCounts ? (remaining! / limit!) * 100 : toNum(o.pctLeft),
		hideBar: o.hideBar || undefined,
		hint: timeline ? undefined : formatReset(o.reset) || undefined,
		timeline,
	};
}

async function fetchJson(url: string, apiKey: string, timeoutMs = 8000): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}

/** "8-13 14:52" — compact timestamp for reset annotations. */
function compactTime(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatReset(iso: unknown): string {
	if (typeof iso !== "string" && typeof iso !== "number") return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return `resets ${compactTime(d)}`;
}

// ─── Provider families (the only place that knows about specific vendors) ──

interface ProviderFamily {
	/** Exact provider id, e.g. "deepseek" or "qwen-token-plan-cn". */
	provider: string;
	/** Fixed display order: pay-as-you-go 1x–2x, subscription plans 3x–5x, kimi 6x. */
	order: number;
	/** Fetch status with the provider's API key and format report rows. */
	query: (apiKey: string) => Promise<Row[]>;
}

/** Standard family: GET one Bearer-token endpoint, then format the JSON. */
function simpleFamily(provider: string, order: number, url: string, format: (data: any) => Row[]): ProviderFamily {
	return { provider, order, query: async (apiKey) => format(await fetchJson(url, apiKey)) };
}

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

/** Format the kimi /usages payload into report rows. */
function formatKimiUsage(d: any): Row[] {
	const rows: Row[] = [];
	const level = d?.user?.membership?.level;
	if (level) rows.push({ label: "Membership", text: String(level) });
	const u = d?.usage;
	if (u?.limit)
		// The weekly quota window is not in the payload; it resets every 7 days.
		// The API dropped `remaining` from `usage` (only limit/used/resetTime
		// remain), so derive it as limit - used when missing.
		rows.push(quotaRow("Week", {
			remaining: u.remaining ?? (toNum(u.limit) !== undefined && toNum(u.used) !== undefined ? toNum(u.limit)! - toNum(u.used)! : undefined),
			limit: u.limit,
			reset: u.resetTime,
			windowMs: 7 * 86400e3,
		}));
	const win = d?.limits?.[0]?.detail;
	if (win?.limit)
		// `remaining` is omitted by the API when the window is exhausted,
		// so derive it as limit - used when missing (same as Week above).
		rows.push(quotaRow("5h window", {
			remaining: win.remaining ?? (toNum(win.limit) !== undefined && toNum(win.used) !== undefined ? toNum(win.limit)! - toNum(win.used)! : undefined),
			limit: win.limit,
			reset: win.resetTime,
			windowMs: kimiWindowMs(d?.limits?.[0]?.window),
		}));
	return rows.length ? rows : [{ label: "usage", text: "no usage data", tone: "warn" }];
}

const FAMILIES: ProviderFamily[] = [
	simpleFamily("kimi-coding", 69, KIMI_USAGE_URL, formatKimiUsage),
	{
		// ZAI Coding Plan (China) accepts the raw API key in the Authorization
		// header with no "Bearer" prefix (Bearer is rejected on some accounts),
		// so it can't use simpleFamily().
		provider: "zai-coding-cn",
		order: 50,
		query: async (apiKey) => {
			const resp = await fetch("https://open.bigmodel.cn/api/monitor/usage/quota/limit", {
				headers: { Authorization: apiKey, "Accept-Language": "en-US,en" },
				signal: AbortSignal.timeout(8000),
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const d = (await resp.json()) as Record<string, any>;
			const limits = d?.data?.limits;
			if (!Array.isArray(limits) || limits.length === 0) return [{ label: "quota", text: "no quota data", tone: "warn" as const }];
			const rows: Row[] = limits.map((l: any): Row => {
				// Labels and order mirror the kimi sections: Week, then 5h window.
				const label =
					l.unit === 6 && l.number === 1 ? "Week" :
					l.unit === 3 && l.number === 5 ? "5h window" :
					l.type === "TIME_LIMIT" ? "MCP monthly" : String(l.type ?? "limit");
				// unit 3 = hours, unit 6 = weeks; other limit types have no known window.
				const windowMs =
					l.unit === 3 ? toNum(l.number) !== undefined ? toNum(l.number)! * 3600e3 : undefined
					: l.unit === 6 ? toNum(l.number) !== undefined ? toNum(l.number)! * 7 * 86400e3 : undefined
					: undefined;
				return quotaRow(label, { remaining: l.remaining, limit: l.usage, usedPct: l.percentage, reset: l.nextResetTime, windowMs });
			});
			const rank = (label: string): number => (label === "Week" ? 0 : label === "5h window" ? 1 : 2);
			rows.sort((a, b) => rank(a.label) - rank(b.label));
			if (d?.data?.level) rows.unshift({ label: "Membership", text: String(d.data.level) });
			return rows;
		},
	},
	simpleFamily("minimax-cn", 40, "https://api.minimaxi.com/v1/token_plan/remains", (d) => {
		const models = d?.model_remains;
		if (!Array.isArray(models) || models.length === 0) return [{ label: "quota", text: "no quota data", tone: "warn" as const }];
		// All models share the same interval/weekly windows. One row per
		// (window × model) so every quota gets its own bar; the shared
		// timeline hangs under the last model row of each window.
		const windows = [
			{ key: "interval", start: "start_time", end: "end_time", total: "current_interval_total_count", used: "current_interval_usage_count", pct: "current_interval_remaining_percent" },
			{ key: "weekly", start: "weekly_start_time", end: "weekly_end_time", total: "current_weekly_total_count", used: "current_weekly_usage_count", pct: "current_weekly_remaining_percent" },
		];
		const rows: Row[] = [];
		for (const wdef of windows) {
			const start = toNum(models[0]?.[wdef.start]);
			const end = toNum(models[0]?.[wdef.end]);
			const hasWindow = start !== undefined && end !== undefined;
			models.forEach((m: any, i: number) => {
				const total = toNum(m[wdef.total]);
				const used = toNum(m[wdef.used]);
				const hasCounts = total !== undefined && used !== undefined && total > 0;
				const last = i === models.length - 1;
				rows.push({
					label: `${wdef.key} ${String(m.model_name ?? "?")}`,
					text: hasCounts ? `${used}/${total}` : undefined,
					percentLeft: toNum(m[wdef.pct]) ?? (hasCounts ? ((total - used) / total) * 100 : undefined),
					// With a timeline the reset time moves to the timeline line.
					hint: last && !hasWindow ? formatReset(end) || undefined : undefined,
					timeline: last && hasWindow ? { startMs: start, endMs: end } : undefined,
				});
			});
		}
		return rows;
	}),
	simpleFamily("deepseek", 20, "https://api.deepseek.com/user/balance", (d) => {
		const infos = d?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) return [{ label: "balance", text: "no balance data", tone: "warn" as const }];
		return infos.map((b: any): Row => ({
			label: `Balance ${b.currency ?? ""}`.trim(),
			text: String(b.total_balance ?? "?"),
		}));
	}),
	{
		// OpenRouter needs two endpoints, so it uses a custom query.
		// Only the free-tier provider is reported; plain "openrouter" is skipped.
		provider: "openrouter-free",
		order: 10,
		query: async (apiKey) => {
			const [credits, keyInfo] = await Promise.all([
				fetchJson("https://openrouter.ai/api/v1/credits", apiKey) as Promise<Record<string, any>>,
				fetchJson("https://openrouter.ai/api/v1/auth/key", apiKey) as Promise<Record<string, any>>,
			]);
			const c = credits?.data ?? {};
			const total = Number(c.total_credits ?? 0);
			const used = Number(c.total_usage ?? 0);
			const monthly = Number(keyInfo?.data?.usage_monthly ?? 0);
			return [
				quotaRow("Balance", { remaining: total - used, limit: total, hideBar: true, format: (n) => `$${n.toFixed(2)}` }),
				{ label: "Usage", text: `$${used.toFixed(2)} total · $${monthly.toFixed(2)} this month` },
			];
		},
	},
];

// ─── Section builders ───────────────────────────────────────────────────────

type Query = (ctx: ExtensionCommandContext) => Promise<Row[]>;

interface Section {
	label: string;
	/** Fixed display order; sections sort ascending before rendering. */
	order: number;
	query: Query;
	/** Provider id this section was discovered from (used for dedup). */
	provider?: string;
}

/** One section per FAMILIES entry whose provider has an API key configured. */
async function discoverSections(ctx: ExtensionCommandContext): Promise<Section[]> {
	const sections: Section[] = [];
	for (const family of FAMILIES) {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(family.provider).catch(() => undefined);
		if (!apiKey) continue;
		const display = ctx.modelRegistry.getProviderDisplayName(family.provider) || family.provider;
		sections.push({
			label: display === family.provider ? family.provider : `${display} (${family.provider})`,
			order: family.order,
			provider: family.provider,
			query: () => family.query(apiKey),
		});
	}
	return sections;
}

// ─── Kimi account slots ───────────────────────────────────────────────────

/** Directory holding extra kimi API-key files (<name>.auth.json). */
function kimiStoreDir(): string | undefined {
	// Only the env var: set KIMI_SWITCH_STORE to a directory of
	// <name>.auth.json ({"key": "sk-..."}) files to report every saved
	// kimi account as its own section. No default — feature is off otherwise.
	return process.env.KIMI_SWITCH_STORE;
}

interface KimiSlot {
	name: string;
	key: string;
}

/** Read every saved kimi account slot; [] if the store is absent or empty. */
function kimiSlots(): KimiSlot[] {
	try {
		const dir = kimiStoreDir();
		if (!dir) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".auth.json"))
			.sort()
			.map((f) => ({
				name: f.replace(/\.auth\.json$/, ""),
				key: (JSON.parse(readFileSync(join(dir, f), "utf8")) as { key?: string }).key ?? "",
			}))
			.filter((s) => s.key.length > 0);
	} catch {
		return [];
	}
}

// ─── Official kimi-code CLI account (OAuth login in ~/.kimi-code) ───────────

const KIMI_CLI_CRED_FILE = join(homedir(), ".kimi-code", "credentials", "kimi-code.json");
const KIMI_CLI_OAUTH_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CLI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

interface KimiCliCreds {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	scope?: string;
	token_type?: string;
}

/** Read the kimi-code CLI OAuth credentials; undefined if absent/corrupt. */
function kimiCliCreds(): KimiCliCreds | undefined {
	try {
		const d = JSON.parse(readFileSync(KIMI_CLI_CRED_FILE, "utf8")) as Partial<KimiCliCreds>;
		if (typeof d.access_token !== "string" || typeof d.refresh_token !== "string") return undefined;
		return {
			access_token: d.access_token,
			refresh_token: d.refresh_token,
			expires_at: typeof d.expires_at === "number" ? d.expires_at : 0,
			scope: d.scope,
			token_type: d.token_type,
		};
	} catch {
		return undefined;
	}
}

/** Persist credentials atomically in the CLI's wire format (0600). */
function saveKimiCliCreds(creds: KimiCliCreds): void {
	const tmp = `${KIMI_CLI_CRED_FILE}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
	renameSync(tmp, KIMI_CLI_CRED_FILE);
}

/** Refresh the CLI's OAuth access token and persist the rotated pair. */
async function refreshKimiCliCreds(creds: KimiCliCreds): Promise<KimiCliCreds> {
	const resp = await fetch(KIMI_CLI_OAUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: KIMI_CLI_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: creds.refresh_token,
		}).toString(),
	});
	if (!resp.ok) throw new Error(`token refresh failed (HTTP ${resp.status})`);
	const d = (await resp.json()) as Record<string, any>;
	const expiresIn = Number(d.expires_in ?? 3600);
	const refreshed: KimiCliCreds = {
		access_token: String(d.access_token),
		refresh_token: String(d.refresh_token ?? creds.refresh_token),
		expires_at: Date.now() / 1000 + expiresIn,
		scope: typeof d.scope === "string" ? d.scope : creds.scope,
		token_type: typeof d.token_type === "string" ? d.token_type : creds.token_type,
	};
	saveKimiCliCreds(refreshed);
	return refreshed;
}

/** Access token for the kimi-code CLI account, refreshing when close to expiry. */
async function kimiCliAccessToken(): Promise<string> {
	const creds = kimiCliCreds();
	if (!creds) throw new Error("no kimi-code CLI credentials");
	if (creds.expires_at > Date.now() / 1000 + 60) return creds.access_token;
	return (await refreshKimiCliCreds(creds)).access_token;
}

// ─── Claude Code account (OAuth login in ~/.claude/.credentials.json) ───────

const CLAUDE_CREDS_FILE = join(homedir(), ".claude", ".credentials.json");
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA_HEADER = "oauth-2025-04-20";
// The usage endpoint is shared with the CLI and can 429 when polled hard; a
// short TTL cache keeps /status refreshes polite and still mostly fresh.
const CLAUDE_USAGE_CACHE_TTL_MS = 60_000;

interface ClaudeOauth {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	refreshTokenExpiresAt?: number;
	scopes?: string[];
	subscriptionType?: string;
	rateLimitTier?: string;
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const isMac = platform() === "darwin";

/**
 * Read the raw claude-code credentials JSON. On macOS the CLI stores its
 * OAuth tokens in the Keychain (service "Claude Code-credentials"), not the
 * ~/.claude/.credentials.json file — that file is a stale fallback whose
 * tokens have usually been rotated server-side, so the Keychain is
 * authoritative on macOS.
 */
function readClaudeCredsRaw(): string | undefined {
	if (isMac) {
		try {
			const out = execFileSync("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"], {
				stdio: ["ignore", "pipe", "ignore"],
			}).toString().trim();
			if (out) return out;
		} catch {
			// fall through to the file
		}
	}
	try {
		return readFileSync(CLAUDE_CREDS_FILE, "utf8");
	} catch {
		return undefined;
	}
}

/** Read the claude-code CLI OAuth credentials; undefined if absent/corrupt. */
function claudeOauth(): ClaudeOauth | undefined {
	const raw = readClaudeCredsRaw();
	if (!raw) return undefined;
	try {
		const o = (JSON.parse(raw) as { claudeAiOauth?: Partial<ClaudeOauth> }).claudeAiOauth;
		if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string") return undefined;
		return {
			accessToken: o.accessToken,
			refreshToken: o.refreshToken,
			expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : 0,
			refreshTokenExpiresAt: o.refreshTokenExpiresAt,
			scopes: o.scopes,
			subscriptionType: o.subscriptionType,
			rateLimitTier: o.rateLimitTier,
		};
	} catch {
		return undefined;
	}
}

/**
 * Access token for the claude-code CLI account. Strictly read-only: an
 * expired token is an error, never refreshed or written back — re-login
 * with the claude CLI to renew.
 */
function claudeAccessToken(): string {
	const oauth = claudeOauth();
	if (!oauth) throw new Error("no claude-code OAuth credentials");
	if (oauth.expiresAt <= Date.now() + 60_000)
		throw new Error(`claude OAuth token expired ${compactTime(new Date(oauth.expiresAt))} — re-login with the claude CLI`);
	return oauth.accessToken;
}

let claudeUsageCache: { rows: Row[]; at: number } | undefined;

/** Fetch subscription usage for the claude-code CLI account (cached briefly). */
async function fetchClaudeUsage(): Promise<Row[]> {
	const accessToken = claudeAccessToken();
	try {
		const resp = await fetch(CLAUDE_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": CLAUDE_BETA_HEADER,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const rows = formatClaudeUsage(await resp.json());
		claudeUsageCache = { rows, at: Date.now() };
		return rows;
	} catch (err) {
		// The endpoint 429s when polled aggressively; serve the last good
		// read within the TTL instead of failing the section.
		if (claudeUsageCache && Date.now() - claudeUsageCache.at < CLAUDE_USAGE_CACHE_TTL_MS) return claudeUsageCache.rows;
		throw err;
	}
}

/** Format the claude /api/oauth/usage payload into report rows. */
function formatClaudeUsage(d: any): Row[] {
	const rows: Row[] = [];
	const tier = claudeOauth()?.subscriptionType;
	if (tier) rows.push({ label: "Membership", text: String(tier) });
	const fiveHour = d?.five_hour;
	const sevenDay = d?.seven_day;
	if (sevenDay && toNum(sevenDay.utilization) !== undefined)
		rows.push(quotaRow("Week", { pctLeft: 100 - toNum(sevenDay.utilization)!, reset: sevenDay.resets_at, windowMs: 7 * 86400e3 }));
	if (fiveHour && toNum(fiveHour.utilization) !== undefined)
		rows.push(quotaRow("5h window", { pctLeft: 100 - toNum(fiveHour.utilization)!, reset: fiveHour.resets_at, windowMs: 5 * 3600e3 }));
	// Fallback when the window objects are absent: the limits[] buckets.
	if (rows.length <= 1 && Array.isArray(d?.limits))
		for (const l of d.limits) {
			const pct = toNum(l?.percent);
			if (pct === undefined) continue;
			const label = l?.kind === "session" ? "Session" : l?.kind === "weekly_all" ? "Week" : String(l?.kind ?? "limit");
			rows.push(quotaRow(label, { pctLeft: 100 - pct, reset: l?.resets_at }));
		}
	const extra = d?.extra_usage;
	const extraUsed = toNum(extra?.used_credits);
	const extraLimit = toNum(extra?.monthly_limit);
	if (extra?.is_enabled && extraLimit !== undefined)
		rows.push(quotaRow("Extra usage", {
			// API reports used credits; quotaRow wants remaining.
			remaining: extraUsed !== undefined ? extraLimit - extraUsed : undefined,
			limit: extraLimit,
			pctLeft: toNum(extra.utilization) !== undefined ? 100 - toNum(extra.utilization)! : undefined,
		}));
	return rows.length ? rows : [{ label: "usage", text: "no usage data", tone: "warn" }];
}

// ─── Codex account (pi's ChatGPT OAuth login: /login → ChatGPT Codex) ────────

// The access token comes from pi's model registry (/login → ChatGPT Codex),
// which refreshes, locks, and persists it. Rate limits live on the ChatGPT
// backend; the CLI uses /wham/… paths (chatgpt.com/backend-api base).
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** chatgpt_account_id claim from a ChatGPT access JWT (pi's codex login). */
function jwtAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
		) as { "https://api.openai.com/auth"?: { chatgpt_account_id?: string } };
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fetch codex rate limits from the ChatGPT backend using pi's own codex
 * login: the access token is resolved via the model registry, so refresh,
 * locking, and persistence are all handled by pi.
 */
async function fetchCodexUsage(ctx: ExtensionCommandContext): Promise<Row[]> {
	const accessToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!accessToken) throw new Error("no pi codex login — run /login and pick ChatGPT Codex");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		// chatgpt.com rejects the request without these (403/404).
		"User-Agent": "codex-cli",
		originator: "codex_cli_rs",
		"OAI-Product-Sku": "codex",
	};
	const accountId = jwtAccountId(accessToken);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const resp = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(8000) });
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	return formatCodexUsage(await resp.json());
}

/** Unix seconds → ms; codex reports epoch seconds. */
function secToMs(v: unknown): number | undefined {
	const n = toNum(v);
	return n !== undefined ? (n < 1e12 ? n * 1000 : n) : undefined;
}

/** Format the codex /wham/usage payload into report rows. */
function formatCodexUsage(d: any): Row[] {
	const rows: Row[] = [];
	if (d?.plan_type) rows.push({ label: "Plan", text: String(d.plan_type) });
	const rl = d?.rate_limit;
	const pw = rl?.primary_window;
	if (pw && toNum(pw.used_percent) !== undefined) {
		const windowSecs = toNum(pw.limit_window_seconds);
		const row = quotaRow(windowSecs === 604800 ? "Week" : windowSecs === 18000 ? "5h window" : "Quota", {
			pctLeft: 100 - toNum(pw.used_percent)!,
			reset: secToMs(pw.reset_at),
			windowMs: windowSecs !== undefined ? windowSecs * 1000 : 7 * 86400e3,
		});
		if (rl?.limit_reached) row.hint = "limit reached";
		rows.push(row);
	}
	const sw = rl?.secondary_window;
	if (sw && toNum(sw.used_percent) !== undefined) {
		const windowSecs = toNum(sw.limit_window_seconds);
		rows.push(quotaRow(windowSecs === 604800 ? "Week" : windowSecs === 18000 ? "5h window" : "Quota", {
			pctLeft: 100 - toNum(sw.used_percent)!,
			reset: secToMs(sw.reset_at),
			windowMs: windowSecs !== undefined ? windowSecs * 1000 : undefined,
		}));
	}
	const credits = d?.credits;
	if (credits?.has_credits)
		rows.push({ label: "Credits", text: `$${toNum(credits.balance) ?? "0"} left`, tone: credits.overage_limit_reached ? "warn" : undefined });
	const sc = d?.spend_control;
	if (sc?.individual_limit != null)
		rows.push({ label: "Spend control", text: sc.reached ? "limit reached" : `limit $${toNum(sc.individual_limit) ?? "?"}`, tone: sc.reached ? "warn" : undefined });
	if (rl && !rl.allowed)
		rows.push({ label: "Status", text: "rate limited", tone: "error", hint: rl?.rate_limit_reached_type != null ? String(rl.rate_limit_reached_type) : undefined });
	return rows.length ? rows : [{ label: "usage", text: "no usage data", tone: "warn" }];
}

// ─── Command ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show remaining quota / balance for all configured providers",
		handler: async (_args, ctx) => {
			const sections = await discoverSections(ctx);

			// Multi-key slots (KIMI_SWITCH_STORE): report every saved account, not
			// just the currently active key, so usage is visible without switching.
			const slots = kimiSlots();
			if (slots.length > 0) {
				const liveKey = await ctx.modelRegistry
					.getApiKeyForProvider("kimi-coding")
					.catch(() => undefined);
				const active = new Set(slots.filter((s) => s.key === liveKey).map((s) => s.name));
				if (active.size > 0) {
					// The active slot already reports the live key's usage; drop
					// the registry-based kimi-coding section as a duplicate.
					for (let i = sections.length - 1; i >= 0; i--) {
						if (sections[i].provider === "kimi-coding") sections.splice(i, 1);
					}
				}
				// Active slot first, then the rest alphabetically.
				const orderedSlots = [...slots].sort(
					(a, b) => Number(active.has(b.name)) - Number(active.has(a.name)) || a.name.localeCompare(b.name),
				);
				orderedSlots.forEach((slot, i) => {
					sections.push({
						label: `Kimi slot: ${slot.name}${active.has(slot.name) ? " (active)" : ""}`,
						order: 61 + i,
						query: async () => formatKimiUsage(await fetchJson(KIMI_USAGE_URL, slot.key)),
					});
				});
			}

			// Official kimi-code CLI account: OAuth login in ~/.kimi-code, often
			// a subscription separate from the API-key slots above.
			if (existsSync(KIMI_CLI_CRED_FILE)) {
				sections.push({
					label: "Kimi cli account",
					order: 60,
					query: async () => formatKimiUsage(await fetchJson(KIMI_USAGE_URL, await kimiCliAccessToken())),
				});
			}

			// Claude Code account: subscription login stored in the Keychain
			// (macOS) or ~/.claude/.credentials.json (other platforms).
			if (claudeOauth()) {
				sections.push({
					label: "Claude account",
					order: 55,
					query: async () => fetchClaudeUsage(),
				});
			}

			// Codex account: pi's own ChatGPT OAuth login (/login → ChatGPT
			// Codex); the token resolves and refreshes via the registry.
			if (await ctx.modelRegistry.getApiKeyForProvider("openai-codex").catch(() => undefined)) {
				sections.push({
					label: "Codex account",
					order: 56,
					query: (qctx) => fetchCodexUsage(qctx),
				});
			}

			if (sections.length === 0) {
				ctx.ui.notify("No configured providers match a known status endpoint.", "info");
				return;
			}

			sections.sort((a, b) => a.order - b.order);

			type SectionState =
				| { status: "pending" }
				| { status: "done"; rows: Row[]; tone: Tone; elapsedMs: number };

			let states: SectionState[] = sections.map(() => ({ status: "pending" }));
			let runGen = 0;
			let lastUpdated = 0;
			let onUpdate: () => void = () => {};

			const rowTone = (r: Row): StyleColor => {
				if (r.tone) return r.tone;
				if (r.percentLeft === undefined) return "ok";
				const t = percentTone(r.percentLeft);
				return t === "error" || t === "warn" ? t : "ok";
			};
			// Section dot: red ✗ only for real failures (explicit error rows);
			// a low-quota percentage alone caps the section at yellow.
			const worstTone = (rows: Row[]): Tone => {
				if (rows.some((r) => r.tone === "error")) return "error";
				return rows.some((r) => rowTone(r) === "error" || rowTone(r) === "warn") ? "warn" : "ok";
			};

			/** Start a fresh round of queries; stale rounds are dropped via runGen. */
			const runAll = (): Promise<void>[] => {
				const gen = ++runGen;
				states = sections.map(() => ({ status: "pending" }));
				return sections.map((s, i) => {
					const started = Date.now();
					const settle = (rows: Row[]): void => {
						if (gen !== runGen) return;
						states[i] = { status: "done", rows, tone: worstTone(rows), elapsedMs: Date.now() - started };
						lastUpdated = Date.now();
						onUpdate();
					};
					return s.query(ctx).then(settle, (err) => {
						const msg = err instanceof Error ? err.message : String(err);
						settle([{ label: "error", text: msg, tone: "error" }]);
					});
				});
			};

			/** Track width shared by the usage bar and the timeline so they line up. */
			const TRACK_W = 20;

			/** Usage bar: filled = consumed (usage tone), dim = remaining headroom. */
			const usageBar = (st: Styler, pctLeft: number): string => {
				const pct = Math.max(0, Math.min(100, Math.round(pctLeft)));
				const filled = Math.round(((100 - pct) / 100) * TRACK_W);
				return st.tone(percentTone(pct), "█".repeat(filled)) + st.dim("░".repeat(TRACK_W - filled));
			};

			/** One-line window timeline: elapsed in accent, ● = now, dim = still ahead. */
			const timelineLine = (st: Styler, { startMs, endMs }: { startMs: number; endMs: number }): string => {
				const now = Date.now();
				const frac = endMs > startMs ? Math.max(0, Math.min(1, (now - startMs) / (endMs - startMs))) : 1;
				const knob = Math.round(frac * (TRACK_W - 1));
				const line = st.tone("accent", "─".repeat(knob) + "●") + st.dim("─".repeat(TRACK_W - 1 - knob));
				const note = `${humanDuration(endMs - now)} to reset (${compactTime(new Date(endMs))})`;
				return `${line}  ${st.dim(note)}`;
			};

			const renderRows = (st: Styler, rows: Row[]): string => {
				const w = Math.max(...rows.map((r) => r.label.length));
				const lines: string[] = [];
				for (const r of rows) {
					const padded = r.label.padEnd(w);
					const bar = r.percentLeft !== undefined && !r.hideBar ? `${usageBar(st, r.percentLeft)}  ` : "";
					const parts: string[] = [];
					if (r.percentLeft !== undefined) {
						const pct = Math.max(0, Math.min(100, Math.round(r.percentLeft)));
						parts.push(st.tone(percentTone(pct), `${100 - pct}% used`));
					}
					if (r.text) parts.push(r.tone ? st.tone(r.tone, r.text) : r.text);
					let line = `  ${r.tone && r.percentLeft === undefined ? st.tone(r.tone, padded) : padded}  ${bar}${parts.join("  ")}`;
					if (r.hint) line += `  ${st.dim(r.hint)}`;
					lines.push(line);
					if (r.timeline) lines.push(`  ${" ".repeat(w)}  ${timelineLine(st, r.timeline)}`);
				}
				return lines.join("\n");
			};

			const renderReport = (st: Styler, interactive: boolean): string => {
				const body = sections
					.map(({ label }, i) => {
						const s = states[i];
						const dot =
							s.status === "pending" ? st.tone("muted", "○")
								: s.tone === "error" ? st.tone("error", "✗")
								: st.tone(s.tone, "●");
						const elapsed = s.status === "done" ? st.dim(` (${(s.elapsedMs / 1000).toFixed(1)}s)`) : "";
						const lines = s.status === "pending" ? `  ${st.dim("querying…")}` : renderRows(st, s.rows);
						return `${dot} ${st.bold(label)}${elapsed}\n${lines}`;
					})
					.join("\n\n");
				const updated = lastUpdated ? `updated ${new Date(lastUpdated).toLocaleTimeString()}` : "";
				const footer = st.dim(interactive ? `r refresh · Esc/q close · ${updated}` : updated);
				return `${body}\n\n${footer}`;
			};

			if (ctx.mode !== "tui") {
				await Promise.all(runAll());
				ctx.ui.notify(renderReport(ansiStyler, false), "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const st: Styler = {
					bold: (s) => theme.bold(s),
					dim: (s) => theme.fg("dim", s),
					tone: (c, s) =>
						theme.fg(c === "ok" ? "success" : c === "warn" ? "warning" : c === "error" ? "error" : c, s),
				};
				let cachedWidth = 0;
				let cachedLines: string[] = [];
				const refresh = (): void => {
					cachedWidth = 0;
					tui.requestRender();
				};
				onUpdate = refresh;
				// Show the panel immediately; each section fills in as its query settles.
				runAll();
				return {
					render(width: number): string[] {
						if (width !== cachedWidth) {
							cachedWidth = width;
							cachedLines = wrapTextWithAnsi(renderReport(st, true), width);
						}
						return cachedLines;
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || data === "q") done();
						else if (data === "r") {
							runAll();
							refresh();
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
