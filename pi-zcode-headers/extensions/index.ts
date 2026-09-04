/**
 * ZCode Headers Extension for pi
 *
 * When the active provider targets Zhipu / Z.AI endpoints
 * (zai-coding, zai-coding-cn, api.z.ai, open.bigmodel.cn), injects the
 * same identity headers that the official ZCode client sends, so the
 * Zhipu backend treats pi traffic as ZCode traffic.
 *
 * Header set extracted from the official ZCode agent runtime
 * (zcode.cjs, app 3.10.2 / runtime 0.16.5) via live capture against
 * both the Anthropic-style (/api/anthropic) and OpenAI-style
 * (/api/coding/paas/v4) coding-plan endpoints.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, homedir, release } from "node:os";
import { join } from "node:path";

// ── Identity defaults ────────────────────────────────────────────────

// ai-sdk provider-utils version embedded in the official runtime's
// User-Agent. The runtime ships two SDK paths with different patch
// versions; match the endpoint style like the real client does.
const AI_SDK_VERSION_ANTHROPIC = "4.0.27";
const AI_SDK_VERSION_OPENAI = "4.0.39";

// Fallback: latest desktop app version observed on the official CDN
// (cdn-zcode.z.ai/zcode/electron/releases). Overridden by detection below.
const FALLBACK_APP_VERSION = "3.10.2";

// ── Provider matching ────────────────────────────────────────────────

const ZAI_PROVIDERS = new Set([
  "zai",
  "zai-coding",
  "zai-coding-cn",
  "zhipu",
  "bigmodel",
  "glm",
  "cangqiong-zai",
]);

const ZAI_BASE_URL_PATTERN = /^https:\/\/(api\.z\.ai|open\.bigmodel\.cn)\//i;

function isZaiProvider(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  // Match by provider name or by baseUrl (covers user-created providers)
  return (
    ZAI_PROVIDERS.has(model.provider as string) ||
    ZAI_BASE_URL_PATTERN.test(model.baseUrl ?? "")
  );
}

// ── Version & surface detection ──────────────────────────────────────

// Resolution order:
//   $ZCODE_APP_VERSION → official desktop app (Info.plist) → official
//   runtime via `zcode --version` (zcode-app-cli vendor bundle) →
//   FALLBACK_APP_VERSION (desktop identity).
type ZCodeIdentity = { version: string; sourceTitle: "electron" | "cli" };

function resolveIdentity(): ZCodeIdentity {
  const envVersion = process.env["ZCODE_APP_VERSION"]?.trim();
  const envTitle = process.env["ZCODE_SOURCE_TITLE"]?.trim();
  if (envVersion) {
    return {
      version: envVersion,
      sourceTitle:
        envTitle === "cli" || envTitle === "electron" ? envTitle : "electron",
    };
  }

  const desktop = desktopAppVersion();
  if (desktop) return { version: desktop, sourceTitle: "electron" };

  const runtime = runtimeVersion();
  if (runtime) return { version: runtime, sourceTitle: "cli" };

  return { version: FALLBACK_APP_VERSION, sourceTitle: "electron" };
}

function desktopAppVersion(): string | undefined {
  const home = homedir();
  const candidates = [
    "/Applications/ZCode.app/Contents/Info.plist",
    join(home, "Applications", "ZCode.app", "Contents", "Info.plist"),
  ];
  for (const plist of candidates) {
    if (!existsSync(plist)) continue;
    try {
      const out = execFileSync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", plist],
        { encoding: "utf-8", timeout: 2000 }
      ).trim();
      if (/^\d+(\.\d+){1,3}$/.test(out)) return out;
    } catch {
      // best-effort: try next candidate
    }
  }
  return undefined;
}

function runtimeVersion(): string | undefined {
  try {
    // `zcode --version` prints e.g. "zcode-app-cli 3.10.2-19\nzcode-runtime 0.16.5"
    const out = execFileSync("zcode", ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    const m = /zcode-runtime\s+(\d+\.\d+(?:\.\d+)?)/.exec(out);
    if (m) return m[1]!;
  } catch {
    // official CLI not installed; fall through
  }
  return undefined;
}

// ── Header construction (mirrors buildZCodeSourceHeadersFromContext) ─

function osCategory(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

// Values only need to be computed once per pi process.
const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
const NODE_MAJOR = process.versions.node?.split(".")[0] ?? "0";
const RELEASE_CHANNEL =
  process.env["ZCODE_ENV"]?.trim().toLowerCase() === "test" ? "test" : "production";
// The official client keeps one session id per client session.
const SESSION_ID = randomUUID();

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const identity = resolveIdentity();

  pi.on("before_provider_headers", (event, ctx) => {
    if (!isZaiProvider(ctx)) return;

    const baseUrl = ctx.model?.baseUrl ?? "";
    const sdkOverride = process.env["ZCODE_AI_SDK_VERSION"]?.trim();
    const sdkVersion =
      sdkOverride ||
      (baseUrl.includes("/anthropic")
        ? AI_SDK_VERSION_ANTHROPIC
        : AI_SDK_VERSION_OPENAI);

    // Client identity — exactly what official ZCode sends.
    event.headers["User-Agent"] =
      `ZCode/${identity.version} ai-sdk/provider-utils/${sdkVersion} runtime/node.js/${NODE_MAJOR}`;
    event.headers["HTTP-Referer"] = "https://zcode.z.ai";
    event.headers["X-Title"] = `Z Code@${identity.sourceTitle}`;
    event.headers["X-ZCode-App-Version"] = identity.version;
    event.headers["X-ZCode-Agent"] = "glm";
    event.headers["X-ZCode-Session-Type"] = "main";

    // Device/platform telemetry identity.
    event.headers["X-Platform"] = `${process.platform}-${arch()}`;
    event.headers["X-Os-Category"] = osCategory();
    event.headers["X-Os-Version"] = release();
    event.headers["X-Client-Language"] = LOCALE;
    event.headers["X-Client-Timezone"] = TIMEZONE;
    event.headers["X-Release-Channel"] = RELEASE_CHANNEL;

    // Session & per-request correlation ids (fresh UUIDs per request,
    // session id stable for the pi process — same as the official client).
    event.headers["X-Session-Id"] = SESSION_ID;
    event.headers["X-Query-Id"] = randomUUID();
    event.headers["X-Request-Id"] = randomUUID();
    event.headers["X-ZCode-Trace-Id"] = randomUUID();

    // The official client emits no OpenAI-SDK fingerprint headers. The SDK
    // injects x-stainless-* after this hook, but openai-node drops any
    // header set to null, so pin them to null to strip downstream.
    for (const key of [
      "x-stainless-arch",
      "x-stainless-lang",
      "x-stainless-os",
      "x-stainless-package-version",
      "x-stainless-retry-count",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "x-stainless-timeout",
    ]) {
      if (!(key in event.headers)) event.headers[key] = null;
    }
  });
}
