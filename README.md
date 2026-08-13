# dsh-webfetch

[![test](https://github.com/withlovehub/dsh-webfetch/actions/workflows/test.yml/badge.svg)](https://github.com/withlovehub/dsh-webfetch/actions/workflows/test.yml)

A zero-dependency **webfetch MCP server**: fetches any `http(s)` URL and returns clean content — text, simplified Markdown, raw HTML, or formatted JSON. Built for [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`), works with any MCP client that supports stdio servers.

- **Zero dependencies**: single `server.js`, hand-rolled stdio JSON-RPC 2.0 — no `npm install`, no SDK version conflicts.
- **Model-friendly output**: main-content extraction (`<main>`/`<article>`), entity decoding, absolute links, image alt text, chunked reading.
- **Polite & safe**: `robots.txt` compliance, Cloudflare-challenge retry, SSRF protection, bounded 5 MiB reads.

## Design references

Compared three existing implementations (2026-08) and adopted the useful parts with zero-dependency equivalents:

| Source | Adopted design |
|---|---|
| Official [mcp-server-fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) | `startIndex` chunked reading, robots.txt compliance, raw mode |
| [OpenCode](https://github.com/sst/opencode) `tool/webfetch.ts` | Format-aware `Accept` headers, Cloudflare challenge → plain-UA retry, 5 MiB bounded reads |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Main-content-first (lightweight Readability heuristic), SSRF protection, relative-link absolutization, image alt |

Deliberately *not* adopted: `@mozilla/readability`, `turndown`, `undici`, `unpdf` — dependency-free equivalents cover the common cases.

## Quick start

Requires Node.js ≥ 20 (uses global `fetch`).

```sh
git clone https://github.com/withlovehub/dsh-webfetch.git
cd dsh-webfetch

# Optional but convenient: puts the `dsh-webfetch` command on your PATH
npm link          # or: npm install -g .

node test.js      # 32 in-process test cases — all green means your Node is ready
```

The server speaks newline-delimited JSON-RPC 2.0 on stdio. Once published to npm, the one-liner is `npx -y dsh-webfetch`.

Smoke-test the server by hand (expect an `initialize` response and a `tools/list` response on stdout):

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node server.js
```

PowerShell equivalent:

```powershell
@(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
) | node server.js
```

## Client setup

The server is a plain stdio MCP server — any MCP client works. Pick your client below; every example uses `node` + the path to `server.js`. Two shortcuts make life easier:

- **Path style**: use forward slashes even on Windows (`C:/dev/dsh-webfetch/server.js`) — Node accepts them and you avoid JSON backslash escaping.
- **After `npm link`**: set `command` to `dsh-webfetch` and drop `args` entirely.

Most clients require an absolute path; `${workspaceFolder}`-style variables only work where documented (VS Code).

### DeepSeek Harness

File: `~/.dsh/cordis.patch.yml`

```yaml
- insert:
    - id: mcp-webfetch
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web
        transport: stdio
        command: node
        args:
          - '/path/to/dsh-webfetch/server.js'
```

Restart `dsh web`; the model gains the **`mcp__web__fetch`** tool.

### Claude Desktop

File: `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`). Restart Claude afterwards.

```json
{
  "mcpServers": {
    "webfetch": {
      "command": "node",
      "args": ["C:/path/to/dsh-webfetch/server.js"]
    }
  }
}
```

### Claude Code

File: `.mcp.json` in your project root, or add it from the CLI:

```sh
claude mcp add webfetch -- node /path/to/dsh-webfetch/server.js
```

```json
{
  "mcpServers": {
    "webfetch": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dsh-webfetch/server.js"]
    }
  }
}
```

Verify with `claude mcp list`.

### Cursor

File: `.cursor/mcp.json` in your project (or Cursor Settings → MCP → Add new MCP server).

```json
{
  "mcpServers": {
    "webfetch": {
      "command": "node",
      "args": ["C:/path/to/dsh-webfetch/server.js"]
    }
  }
}
```

Verify in Cursor Settings → MCP (green status dot).

### VS Code Copilot

File: `.vscode/mcp.json` — supports the `${workspaceFolder}` variable, so a cloned repo can self-configure:

```json
{
  "servers": {
    "webfetch": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/server.js"]
    }
  }
}
```

Verify: Command Palette → **MCP: List Servers**.

### OpenCode

File: `opencode.json` (project) or global config.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "webfetch": {
        "type": "local",
        "command": ["node", "/path/to/dsh-webfetch/server.js"]
      }
    }
  }
}
```

Verify with `opencode2 mcp list` (v1: `opencode mcp list`).

### Anything else

Any MCP client that speaks stdio works with the same `command` + `args` shape — the protocol is universal.

## Tool parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string (required) | — | Full URL, http/https only (`file://` rejected) |
| `format` | text / markdown / html / json | text | text = cleaned content; markdown = links/headings/images kept; html = raw HTML; json = pretty-printed JSON |
| `maxChars` | 1000–200000 | 60000 | Maximum characters returned this call |
| `startIndex` | 0–10000000 | 0 | Start content from this character index — pair with `maxChars` to read long pages in chunks |
| `timeoutMs` | 3000–120000 | 20000 | Request timeout |

## Behavior

- **Main-content first**: if the text of a `<main>`/`<article>` block is ≥ 30% of the page, only that block is returned — nav/footer noise is filtered (lightweight Readability).
- **HTML cleaning**: script/style/svg dropped, block tags become newlines, entities decoded, `<title>` extracted.
- **Markdown mode**: relative hrefs/srcs absolutized against the final URL (`javascript:`/`mailto:` degrade to plain text), images become `![alt](url)`, h1–h6 become ATX headings; links wrapping images keep the alt text.
- **JSON APIs**: auto `JSON.parse` + indent; invalid JSON returns `isError` with a preview instead of silently passing raw text.
- **Binary**: returns metadata only (status/content-type/bytes) — bytes are never fed into the model context.
- **robots.txt**: respected by default (`dsh-webfetch` group, then `*` group, longest-prefix match); blocked URLs return `isError`; results cached 30 min; set `DSH_WEBFETCH_IGNORE_ROBOTS=1` to disable. Empty `Disallow:` means allow-all per RFC 9309.
- **Cloudflare challenge**: on `403` + `cf-mitigated: challenge`, retries once with a transparent UA.
- **SSRF protection**: rejects `metadata.google.internal`, `169.254.*`, `0.0.0.0`.
- **Bounded reads**: max 5 MiB per response (declared limit → error; undeclared → streaming cutoff).
- **Errors**: failures return MCP `isError: true`; diagnostics go to stderr only (stdout is the protocol channel).

## Known limitations

- No JavaScript execution — SPAs return the raw shell, not the rendered app.
- No PDF extraction / true Readability / proxy support (zero-dependency line; add when actually needed).
- Malformed HTML with quotes inside hrefs degrades to plain text rather than crashing.

## License

MIT
