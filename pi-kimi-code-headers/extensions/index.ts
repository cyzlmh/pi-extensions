/**
 * Kimi Code Headers Extension for pi
 *
 * When the active provider is Kimi (kimi-coding / moonshotai / moonshotai-cn),
 * injects the same device-identity headers that kimi-code-cli sends so the
 * Kimi backend treats pi traffic as Kimi Code traffic.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, hostname, release, type } from "node:os";
import { join } from "node:path";

const HOME = process.env["HOME"] ?? "~";
const PI_HOME = join(HOME, ".pi");
const DEVICE_ID_FILE = join(PI_HOME, "kimi-device-id");
const OFFICIAL_DEVICE_ID_FILE = join(HOME, ".kimi-code", "device_id");
const KIMI_CLI_BIN = join(HOME, ".kimi-code", "bin", "kimi");
const VERSION_CACHE_FILE = join(PI_HOME, "kimi-cli-version");
const FALLBACK_VERSION = "0.28.1";

// ── Provider matching ────────────────────────────────────────────────

const KIMI_PROVIDERS = new Set([
  "kimi-coding",
  "kimi-plan",
  "moonshotai",
  "moonshotai-cn",
]);

const KIMI_BASE_URL_PATTERN = /^https:\/\/api\.kimi\.com/;

function isKimiProvider(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  // Match by provider name or by baseUrl (covers user-created providers)
  return (
    KIMI_PROVIDERS.has(model.provider as string) ||
    KIMI_BASE_URL_PATTERN.test(model.baseUrl ?? "")
  );
}

// ── Device ID ─────────────────────────────────────────────────────────

function loadOrCreateDeviceId(): string {
  // Prefer the official kimi-code CLI's device id so both share one identity.
  try {
    const official = readFileSync(OFFICIAL_DEVICE_ID_FILE, "utf-8").trim();
    if (official.length > 0) return official;
  } catch {
    // official CLI not installed; fall through
  }
  if (existsSync(DEVICE_ID_FILE)) {
    try {
      const text = readFileSync(DEVICE_ID_FILE, "utf-8").trim();
      if (text.length > 0) return text;
    } catch {
      // best-effort: fall through to (re)creation
    }
  }
  const id = randomUUID();
  try {
    mkdirSync(PI_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(DEVICE_ID_FILE, id, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort: in-memory id is fine
  }
  return id;
}

// ── CLI version (resolved dynamically, never hardcoded) ─────────────

// Resolution order: $KIMI_CLI_VERSION → official `kimi --version` (cached,
// invalidated when the binary changes) → FALLBACK_VERSION.
function resolveKimiVersion(): string {
  const envVersion = process.env["KIMI_CLI_VERSION"]?.trim();
  if (envVersion) return envVersion;
  try {
    const binMtime = statSync(KIMI_CLI_BIN).mtimeMs;
    if (existsSync(VERSION_CACHE_FILE)) {
      const cached = JSON.parse(readFileSync(VERSION_CACHE_FILE, "utf-8"));
      if (cached.binMtime === binMtime && typeof cached.version === "string") {
        return cached.version;
      }
    }
    const version = execFileSync(KIMI_CLI_BIN, ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (/^\d+\.\d+\.\d+/.test(version)) {
      try {
        writeFileSync(VERSION_CACHE_FILE, JSON.stringify({ binMtime, version }), {
          encoding: "utf-8",
          mode: 0o600,
        });
      } catch {
        // best-effort: cache is an optimization
      }
      return version;
    }
  } catch {
    // official CLI missing or failed; fall through
  }
  return FALLBACK_VERSION;
}

// ── Headers ───────────────────────────────────────────────────────────

function asciiHeader(value: string, fallback = "unknown"): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function deviceModel(): string {
  const os = type();
  const version = release();
  const osArch = arch();
  if (os === "Darwin") return `macOS ${macOsProductVersion() ?? version} ${osArch}`;
  if (os === "Windows_NT") return `Windows ${version} ${osArch}`;
  return `${os} ${version} ${osArch}`.trim();
}

let cachedMacVersion: string | undefined;

function macOsProductVersion(): string | undefined {
  if (cachedMacVersion !== undefined) return cachedMacVersion || undefined;
  try {
    const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    cachedMacVersion = version;
    return version.length > 0 ? version : undefined;
  } catch {
    cachedMacVersion = "";
    return undefined;
  }
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const deviceId = loadOrCreateDeviceId();
  const kimiVersion = resolveKimiVersion();

  pi.on("before_provider_headers", (_event, ctx) => {
    if (!isKimiProvider(ctx)) return;

    // Override User-Agent to mimic kimi-code-cli
    _event.headers["User-Agent"] = `kimi-code-cli/${kimiVersion}`;

    // Device identity headers (same as Kimi Code sends)
    _event.headers["X-Msh-Platform"] = "kimi_code_cli";
    _event.headers["X-Msh-Version"] = kimiVersion;
    _event.headers["X-Msh-Device-Name"] = asciiHeader(hostname());
    _event.headers["X-Msh-Device-Model"] = asciiHeader(deviceModel());
    _event.headers["X-Msh-Os-Version"] = asciiHeader(release());
    _event.headers["X-Msh-Device-Id"] = deviceId;
  });
}
