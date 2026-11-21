#!/usr/bin/env bun
/**
 * aiu — your AI plan limits at a glance: % used + reset timers.
 *
 *   aiu                    all providers, one compact line each
 *   aiu claude             one provider, one line
 *   aiu --full             all providers, pretty printout
 *   aiu claude --full      one provider, pretty printout
 *   aiu --json             raw normalized limits as JSON
 *   aiu --refresh          bypass the cache (--ttl N to change the 120s default)
 *
 * Results are cached in ~/.cache/aiu/. After a 429 aiu backs off (honouring
 * Retry-After) and serves the last good data, marked stale, until it clears.
 *
 * Providers: claude
 * Claude data comes live from Anthropic using the Claude Code OAuth token (macOS
 * keychain "Claude Code-credentials", or ~/.claude/.credentials.json). The token
 * is held in memory only: never stored, logged or printed.
 *
 * Adding a provider: write a function returning a list of `Window`s and register
 * it in PROVIDERS.
 */
import { Argument, Command, InvalidArgumentError } from "commander";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// ── types ────────────────────────────────────────────────────────────────────
class ProviderError extends Error {
  /** retryAfter: seconds to back off before hitting the API again */
  constructor(msg: string, readonly retryAfter?: number) {
    super(msg);
  }
}

/** Normalized limit window. pct: 0-100. */
interface Window {
  label: string;
  short: string;
  sub: string;
  pct: number;
  reset: Date | null;
}

interface Result {
  name: string;
  wins: Window[];
  err: string | null;
  age: number | null;
  stale: boolean;
}

type RGB = readonly [number, number, number];

interface Provider {
  title: string;
  fetch: () => Promise<Window[]>;
  color: RGB;
}

// ── styling ──────────────────────────────────────────────────────────────────
const COLOR = !!process.stdout.isTTY && !("NO_COLOR" in process.env);
const rgb = ([r, g, b]: RGB, s: string) => (COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s);
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);
const CLAY: RGB = [217, 119, 87];
const GREEN: RGB = [158, 206, 106];
const AMBER: RGB = [224, 175, 104];
const RED: RGB = [247, 118, 142];
const levelColor = (pct: number) => (pct < 60 ? GREEN : pct < 85 ? AMBER : RED);

// ── provider: claude ─────────────────────────────────────────────────────────
const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_WINDOWS: Record<string, [label: string, short: string, sub: string]> = {
  five_hour: ["Session", "5h", "5-hour window"],
  seven_day: ["Week", "7d", "all models"],
  seven_day_opus: ["Week · Opus", "7d-opus", ""],
  seven_day_sonnet: ["Week · Sonnet", "7d-sonnet", ""],
  seven_day_oauth_apps: ["Week · Apps", "7d-apps", ""],
};

const BACKOFF = 300; // seconds to stay off the API after a 429 with no Retry-After

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function claudeToken(): Promise<string> {
  let raw: string | null = null;
  if (platform() === "darwin") {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    raw = r.stdout.toString().trim() || null;
  }
  if (raw === null) {
    try {
      raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    } catch {}
  }
  if (!raw) throw new ProviderError("no Claude Code credentials found; run `claude` and log in");
  try {
    const token = JSON.parse(raw).claudeAiOauth.accessToken;
    if (typeof token !== "string") throw 0;
    return token;
  } catch {
    throw new ProviderError("credentials found but in an unexpected format");
  }
}

async function claudeWindows(): Promise<Window[]> {
  let res: Response;
  try {
    res = await fetch(CLAUDE_URL, {
      headers: {
        Authorization: `Bearer ${await claudeToken()}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "aiu/0.3",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`network error: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("token rejected (expired?); open `claude` once to refresh it");
    }
    if (res.status === 429) {
      const h = res.headers.get("Retry-After") ?? "";
      const wait = /^\d+$/.test(h) ? parseInt(h, 10) : BACKOFF;
      throw new ProviderError("rate limited by Anthropic (HTTP 429)", Math.max(wait, 30));
    }
    throw new ProviderError(`usage endpoint returned HTTP ${res.status}`);
  }
  let data: Record<string, any>;
  try {
    const body = await res.json();
    if (!isObj(body)) throw 0;
    data = body;
  } catch {
    throw new ProviderError("usage endpoint returned an unexpected response");
  }

  const keys = Object.keys(CLAUDE_WINDOWS).filter((k) => isObj(data[k]));
  keys.push(...Object.keys(data).filter((k) => !(k in CLAUDE_WINDOWS) && isObj(data[k]) && "utilization" in data[k]));
  const wins: Window[] = [];
  for (const k of keys) {
    const w = data[k];
    if (w.utilization == null) continue;
    const [label, short, sub] = CLAUDE_WINDOWS[k] ?? [
      k.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      k.replaceAll("_", "-"),
      "",
    ];
    wins.push({ label, short, sub, pct: Number(w.utilization), reset: parseDate(w.resets_at) });
  }

  // Per-model weekly limits (e.g. Fable) only appear in the `limits` array.
  if (Array.isArray(data.limits)) {
    for (const l of data.limits) {
      const model = l?.kind === "weekly_scoped" ? l.scope?.model?.display_name : null;
      if (typeof model !== "string" || l.percent == null) continue;
      const short = `7d-${model.toLowerCase().replaceAll(/\s+/g, "-")}`;
      if (wins.some((w) => w.short === short)) continue; // already covered by a top-level field
      wins.push({ label: `Week · ${model}`, short, sub: "", pct: Number(l.percent), reset: parseDate(l.resets_at) });
    }
  }
  return wins;
}

const PROVIDERS: Record<string, Provider> = {
  claude: { title: "Claude", fetch: claudeWindows, color: CLAY },
};

// ── cache ────────────────────────────────────────────────────────────────────
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "aiu");
const DEFAULT_TTL = 120; // seconds a successful fetch is reused

interface Cache {
  fetched_at?: number;
  blocked_until?: number;
  windows?: Window[];
}

const cachePath = (name: string) => join(CACHE_DIR, `${name}.json`);

function cacheRead(name: string): Cache {
  try {
    const c = JSON.parse(readFileSync(cachePath(name), "utf8"));
    if (!isObj(c)) return {};
    if (c.windows !== undefined) {
      c.windows = (c.windows as any[]).map((w) => ({ ...w, reset: parseDate(w.reset) }));
    }
    return c;
  } catch {
    return {};
  }
}

function cacheWrite(name: string, c: Cache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const out = { ...c, windows: c.windows?.map((w) => ({ ...w, reset: w.reset?.toISOString() ?? null })) };
    const tmp = `${cachePath(name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, cachePath(name));
  } catch {} // caching is best-effort
}

/** Serves cache within ttl or during a backoff; on failure falls back to the last good data, marked stale. */
async function load(name: string, ttl: number, force: boolean): Promise<Result> {
  const c = cacheRead(name);
  const now = Date.now() / 1000;
  const age = c.fetched_at !== undefined ? now - c.fetched_at : null;
  const blocked = (c.blocked_until ?? 0) > now;

  if (c.windows !== undefined && age !== null && !force && (age < ttl || blocked)) {
    return { name, wins: c.windows, err: null, age, stale: blocked && age >= ttl };
  }
  if (blocked && !force) {
    // backing off with nothing usable cached
    const left = Math.floor(c.blocked_until! - now);
    const err = `rate limited by Anthropic; backing off for ${Math.floor(left / 60)}m${String(left % 60).padStart(2, "0")}s`;
    return { name, wins: [], err, age: null, stale: false };
  }
  try {
    const wins = await PROVIDERS[name]!.fetch();
    cacheWrite(name, { fetched_at: now, windows: wins });
    return { name, wins, err: null, age: 0, stale: false };
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.retryAfter) {
      c.blocked_until = now + e.retryAfter;
      cacheWrite(name, c);
    }
    if (c.windows?.length) return { name, wins: c.windows, err: null, age, stale: true };
    return { name, wins: [], err: e.message, age: null, stale: false };
  }
}

// ── rendering ────────────────────────────────────────────────────────────────
const RULE = dim(`  ${"─".repeat(66)}`);

function countdown(dt: Date, compact = false): string {
  const secs = Math.floor((dt.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  if (compact) return d ? `${d}d${h}h` : h ? `${h}h${mm}m` : `${m}m`;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${m}m`;
}

function atLabel(dt: Date): string {
  const now = new Date();
  const day = dt.toDateString() === now.toDateString() ? "" : `${dt.toLocaleDateString("en-US", { weekday: "short" })} `;
  const time = `${dt.getHours() % 12 || 12}:${String(dt.getMinutes()).padStart(2, "0")}${dt.getHours() < 12 ? "am" : "pm"}`;
  return day + time;
}

function bar(pct: number, width = 28): string {
  const eighths = Math.round((Math.min(pct, 100) / 100) * width * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const blocks = "█".repeat(full) + (rem ? " ▏▎▍▌▋▊▉"[rem]! : "");
  return rgb(levelColor(pct), blocks) + dim("·".repeat(width - blocks.length));
}

function ago(secs: number): string {
  secs = Math.floor(secs);
  return secs < 90 ? `${secs}s` : secs < 5400 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
}

function renderBlock(r: Result): string[] {
  const { title, color } = PROVIDERS[r.name]!;
  let head = `  ${rgb(color, "◆")} ${bold(title)}`;
  if (r.stale) head += `  ${rgb(AMBER, "stale")} ${dim(`· cached ${ago(r.age!)} ago, API unavailable`)}`;
  const out = [head, ""];
  if (r.err) out.push(`  ${rgb(RED, "✗")} ${r.err}`, "");
  else if (!r.wins.length) out.push(dim("  no limit windows reported for this account"), "");
  for (const w of r.wins) {
    out.push(w.sub ? `  ${bold(w.label)}  ${dim(w.sub)}` : `  ${bold(w.label)}`);
    let line = `  ${bar(w.pct)}  ${bold(rgb(levelColor(w.pct), `${w.pct.toFixed(0)}%`.padStart(4)))}`;
    if (w.reset) line += `   ${dim("resets in")} ${countdown(w.reset)} ${dim(`· ${atLabel(w.reset)}`)}`;
    else if (w.pct === 0) line += `   ${dim("timer starts on next message")}`;
    out.push(line, "");
  }
  return out;
}

function renderFull(results: Result[]): string {
  const out = ["", `  ${bold("aiu")}  ${dim("· plan limits")}`, RULE, ""];
  results.forEach((r, i) => {
    out.push(...renderBlock(r));
    if (i < results.length - 1) out.push(RULE, "");
  });
  out.push(RULE, "");
  return out.join("\n");
}

function renderLine(r: Result): string {
  const { title, color } = PROVIDERS[r.name]!;
  const head = `${rgb(color, "◆")} ${bold(title.toLowerCase().padEnd(6))}`;
  if (r.err) return `${head} ${rgb(RED, "✗")} ${r.err}`;
  if (!r.wins.length) return `${head} ${dim("no limits reported")}`;
  const parts = r.wins.map((w) => {
    let s = `${dim(w.short)} ${rgb(levelColor(w.pct), `${w.pct.toFixed(0)}%`)}`;
    if (w.reset) s += dim(` ↻${countdown(w.reset, true)}`);
    return s;
  });
  return `${head} ${parts.join(dim(" · "))}${r.stale ? ` ${rgb(AMBER, "(stale)")}` : ""}`;
}

// ── main ─────────────────────────────────────────────────────────────────────
interface Options {
  full?: boolean;
  json?: boolean;
  ttl: number;
  refresh?: boolean;
}

function parseTtl(v: string): number {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError("must be a non-negative integer");
  return parseInt(v, 10);
}

async function main() {
  const program = new Command("aiu")
    .description("AI plan limits: % used + reset timers.")
    .addArgument(new Argument("[provider]", "provider to show (default: all)").choices(Object.keys(PROVIDERS).sort()))
    .option("-f, --full", "full pretty printout instead of one line per provider")
    .option("--json", "print normalized limits as JSON")
    .option("--ttl <secs>", "reuse cached results younger than this", parseTtl, DEFAULT_TTL)
    .option("-r, --refresh", "ignore the cache and fetch now")
    .showHelpAfterError();
  program.parse();
  const provider = program.args[0];
  const opts = program.opts<Options>();

  const names = provider ? [provider] : Object.keys(PROVIDERS);
  const results = await Promise.all(names.map((n) => load(n, opts.ttl, !!opts.refresh)));

  if (opts.json) {
    const out = Object.fromEntries(
      results.map((r) => [
        r.name,
        {
          error: r.err,
          stale: r.stale,
          windows: r.wins.map((w) => ({ ...w, reset: w.reset?.toISOString() ?? null })),
        },
      ]),
    );
    console.log(JSON.stringify(out, null, 2));
  } else if (opts.full) {
    console.log(renderFull(results));
  } else {
    console.log(results.map(renderLine).join("\n"));
  }
  if (results.every((r) => r.err)) process.exitCode = 1;
}

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
});

await main();
