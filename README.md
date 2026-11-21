# aiu

Your AI plan limits at a glance: % used and reset timers, in one line.

```
$ aiu
◆ claude 5h 4% ↻51m · 7d 9% ↻5d17h · 7d-fable 8% ↻5d17h
```

```
$ aiu --full

  aiu  · plan limits
  ──────────────────────────────────────────────────────────────────

  ◆ Claude

  Session  5-hour window
  █▏··························    4%   resets in 51m · 12:10pm

  Week  all models
  ██▌·························    9%   resets in 5d 17h · Fri 5:00am

  Week · Fable
  ██▎·························    8%   resets in 5d 17h · Fri 4:59am
```

Bars and percentages are green below 60%, amber below 85%, red above.

## Install

Requires [Bun](https://bun.sh).

```sh
git clone <this repo> aiu && cd aiu
bun install
bun link
```

`bun link` puts an `aiu` command in `~/.bun/bin`. Make sure that directory is on
your `PATH`:

```sh
export PATH="$HOME/.bun/bin:$PATH"
```

The command runs the source directly, so keep the cloned folder where it is.
`bun unlink` removes it.

## Usage

```
aiu [options] [provider]

  provider       provider to show (default: all)

  -f, --full     full pretty printout instead of one line per provider
  --json         print normalized limits as JSON
  --ttl <secs>   reuse cached results younger than this (default: 120)
  -r, --refresh  ignore the cache and fetch now
  -h, --help     display help for command
```

Colors are disabled when output isn't a terminal or `NO_COLOR` is set. The exit
code is 1 when every provider failed.

## Providers

### claude

Usage comes live from Anthropic, using the OAuth token that
[Claude Code](https://claude.com/claude-code) already has:

- macOS: the keychain item `Claude Code-credentials`
- otherwise: `~/.claude/.credentials.json`

Run `claude` once and log in if no credentials are found. The token is held in
memory only and is never stored, logged or printed.

Windows shown: the 5-hour session, the 7-day limit across all models, and any
per-model weekly limits on your account (Opus, Sonnet, Fable, ...).

## Caching

Results are cached in `~/.cache/aiu/` (or `$XDG_CACHE_HOME/aiu/`) for 120
seconds. After an HTTP 429, aiu backs off (honouring `Retry-After`) and serves
the last good data marked `(stale)` until the limit clears.

## Adding a provider

Write a function that returns a list of `Window`s and register it in
`PROVIDERS` in `aiu.ts`:

```ts
const PROVIDERS: Record<string, Provider> = {
  claude: { title: "Claude", fetch: claudeWindows, color: CLAY },
};
```

Throw a `ProviderError` for failures that should show as a message (pass a
second argument to trigger the backoff).

## Development

```sh
bun run typecheck
./aiu.ts --full
```
