# dsh-webfetch

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
node server.js
```

The server speaks newline-delimited JSON-RPC 2.0 on stdio. Test it:

```sh
node test.js   # 32 in-process test cases (protocol, cleaning, robots, CF retry, SSRF, chunking)
```

## DeepSeek Harness integration

Add an entry to your home-level patch `~/.dsh/cordis.patch.yml`:

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

## Generic MCP client integration

Any MCP client with stdio servers (Claude Code, etc.):

```json
{
  "mcpServers": {
    "webfetch": {
      "command": "node",
      "args": ["/path/to/dsh-webfetch/server.js"]
    }
  }
}
```

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
