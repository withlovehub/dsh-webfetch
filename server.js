#!/usr/bin/env node
'use strict'
/**
 * dsh-webfetch — DeepSeek Harness 专用 webfetch MCP 服务器
 *
 * 为什么是单文件零依赖：DSH 的 mcp-client 会直接 spawn node 运行本文件，
 * 手写 stdio JSON-RPC 就免去 npm install，也不会和 DSH 内置的
 * @modelcontextprotocol/sdk 版本冲突（协议只认 JSON-RPC 2.0 文本行）。
 *
 * 设计参考（2026-08 对比三套现成实现后取舍）：
 * - 官方 mcp-server-fetch：start_index 分块阅读、robots.txt 合规、raw 模式
 * - OpenCode packages/core/src/tool/webfetch.ts：按 format 发 Accept 头、
 *   Cloudflare 挑战换 UA 重试、html 格式即原样、5 MiB 有界读取
 * - pi-web-access：正文优先（main/article 启发式，轻量版 Readability）、
 *   SSRF 防护、相对链接绝对化、图片 alt 转 markdown
 * 全部用零依赖等价实现，不引入 readability/turndown/undici。
 */

// ---------- 常量 ----------

// 与 DSH 内置 SDK 1.30 (types.js SUPPORTED_PROTOCOL_VERSIONS) 完全一致，
// 保证握手时返回的版本一定被客户端接受。
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const DEFAULT_PROTOCOL = '2025-03-26'
const SERVER_INFO = { name: 'dsh-webfetch', version: '1.1.0' }

// 读取上限：防止一个几 GB 的页面把内存打爆；和 OpenCode 一致取 5 MiB。
const MAX_BODY_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_CHARS = 60000
const DEFAULT_TIMEOUT_MS = 20000
// 浏览器 UA：不少站点对 curl/node 默认 UA 直接 403。
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 dsh-webfetch/1.1'
// 挑战重试用 UA：Cloudflare 只对浏览器 UA 弹挑战时，换透明 UA 反而能过（OpenCode 同款策略）。
const PLAIN_UA = 'dsh-webfetch/1.1 (+https://harness.deepseek.com)'

// robots.txt 每 origin 缓存 30 分钟：避免每次抓取都多发一个请求。
const ROBOTS_CACHE = new Map()
const ROBOTS_TTL_MS = 30 * 60 * 1000

// ---------- 工具定义 ----------

const TOOL_DEF = {
  name: 'fetch',
  description:
    '抓取任意 http/https 网页或 API 并返回干净内容。网页自动抽取正文（main/article 优先），' +
    '可输出清洗文本 / 简化 Markdown（链接绝对化、保留标题与图片 alt）/ 原样 HTML / 格式化 JSON。' +
    '长文用 startIndex + maxChars 分块阅读。默认遵守 robots.txt。' +
    '适合读文章、查 API、核对页面状态；不适合下载二进制（图片/PDF 只返回元信息）。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整 URL（http:// 或 https://）' },
      format: {
        type: 'string',
        enum: ['text', 'markdown', 'html', 'json'],
        description: '输出格式：text=清洗后纯文本（默认）；markdown=保留链接/标题/图片的简化 Markdown；html=原样 HTML；json=格式化 JSON',
      },
      maxChars: {
        type: 'integer',
        minimum: 1000,
        maximum: 200000,
        default: DEFAULT_MAX_CHARS,
        description: '本次返回内容的最大字符数，超出截断',
      },
      startIndex: {
        type: 'integer',
        minimum: 0,
        maximum: 10000000,
        default: 0,
        description: '从正文第几个字符开始返回（配合 maxChars 分块阅读长文，第一次先 0 再递进）',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 3000,
        maximum: 120000,
        default: DEFAULT_TIMEOUT_MS,
        description: '请求超时（毫秒）',
      },
    },
    required: ['url'],
  },
}

// ---------- 日志 ----------

// stdout 是协议通道，任何诊断信息只能走 stderr，否则握手直接崩。
function log(...args) {
  process.stderr.write(`[dsh-webfetch] ${args.join(' ')}\n`)
}

// ---------- HTML 清洗 ----------

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'",
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
  '&middot;': '·', '&copy;': '©', '&reg;': '®', '&trade;': '™', '&laquo;': '«', '&raquo;': '»', '&yen;': '¥',
}

function decodeEntities(s) {
  // 先处理命名实体，再处理数字实体；两者互不嵌套。
  return s
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
}

function safeCodePoint(cp) {
  // 过滤代理区/控制字符，防止脏数据混进输出。
  return cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' '
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim()
}

// 这些块级标签的闭合换行，其余标签一律删除——比维护一整棵 DOM 轻两个数量级。
const BLOCK_END = /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dt|dd|figure|figcaption|form|fieldset|header|footer|main|nav|aside|details|summary)>/gi

// 相对链接绝对化：模型拿到绝对 URL 才能继续抓取子链接（pi/turndown 同款行为）。
function mdUrl(href, baseUrl) {
  const h = (href || '').trim()
  if (!h || /^(javascript:|mailto:|tel:|data:)/i.test(h)) return null
  try { return new URL(h, baseUrl).href } catch { return null }
}

function htmlToText(html, asMarkdown, baseUrl) {
  let s = String(html)
  if (asMarkdown) {
    // 链接/标题/图片要在剥标签之前转 Markdown，否则 href/src 信息就没了。
    // 带引号与不带引号的 href 各扫一遍（先带引号，剩下的才可能是不带引号）。
    const linkReplace = (m, href, inner) => {
      let text = stripTags(inner)
      // 图片型链接（logo 等）：文本节点为空时用 img 的 alt 当链接文本，避免整条链接消失。
      if (!text) {
        const alt = /<img\b[^>]*\balt=["']([^"']*)["']/i.exec(inner)
        if (alt && alt[1]) text = alt[1]
      }
      if (!text) return ''
      const abs = mdUrl(href, baseUrl)
      return abs ? `[${text}](${abs})` : text // javascript:/mailto: 等无效链接降级为纯文本
    }
    s = s.replace(/<a\b[^>]*href=(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, href, inner) => linkReplace(0, href, inner))
    s = s.replace(/<a\b[^>]*href=([^\s"'>]+)[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => linkReplace(0, href, inner))
    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n${'#'.repeat(Number(n))} ${stripTags(inner)}\n`)
    s = s.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /src=["']([^"']+)["']/i.exec(tag)
      if (!src) return ''
      const abs = mdUrl(src[1], baseUrl)
      const alt = /\balt=["']([^"']*)["']/i.exec(tag)
      return abs ? `![${(alt && alt[1]) || ''}](${abs})` : ''
    })
  }
  // 无内容区块整体丢弃，避免导航/脚本噪声混进正文。
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_END, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  // 压缩行首行尾空白、合并空行；保持正文可读但不浪费 token。
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 轻量版 Readability：main/article 块的纯文本占比达到全文 30% 就只取它，
// 把导航/页脚噪声挡在输出之外（pi 用 @mozilla/readability，这里用启发式等价物）。
function pickMainContent(html) {
  const blocks = []
  for (const m of html.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/gi)) blocks.push(m[2])
  if (blocks.length === 0) return html
  const textLen = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
  let best = blocks[0]
  for (const b of blocks) if (textLen(b) > textLen(best)) best = b
  return textLen(best) >= textLen(html) * 0.3 ? best : html
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i

// ---------- 抓取 ----------

function acceptHeaderFor(format) {
  // 按目标格式排优先级（OpenCode 同款）：问服务器直接要 markdown，很多站点/接口会配合。
  switch (format) {
    case 'markdown': return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
    case 'html': return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1'
    case 'json': return 'application/json;q=1.0, application/*+json;q=0.9, */*;q=0.1'
    default: return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
  }
}

function charsetOf(contentType) {
  const m = /charset=([^;\s]+)/i.exec(contentType || '')
  if (m) {
    try { new TextDecoder(m[1]); return m[1] } catch { /* 非法编码名回落 utf-8 */ }
  }
  return 'utf-8'
}

// 流式按上限读取：无 content-length 时也不怕超大响应体。
async function readBody(body, maxBytes) {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`响应体超过读取上限 ${Math.round(maxBytes / 1024 / 1024)} MiB`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

async function fetchPage(url, timeoutMs, userAgent, format) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow', // 跟随跳转，拿最终 URL
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: acceptHeaderFor(format),
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    const contentType = res.headers.get('content-type') || ''
    const declared = Number(res.headers.get('content-length') || '0')
    if (declared > MAX_BODY_BYTES) {
      throw new Error(`内容声明 ${Math.round(declared / 1024)} KiB，超过上限 ${MAX_BODY_BYTES / 1024 / 1024} MiB`)
    }
    const buf = await readBody(res.body, MAX_BODY_BYTES)
    const text = new TextDecoder(charsetOf(contentType)).decode(buf)
    return { status: res.status, finalUrl: res.url, contentType, bytes: buf.length, text, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- robots.txt 合规 ----------

/**
 * 按 Google 规则解析 robots.txt（官方 mcp-server-fetch 同款行为）：
 * 找 dsh-webfetch 组，找不到用 * 组；最长前缀匹配 Allow/Disallow。
 * 拿不到 robots.txt 视为允许；失败结果也缓存，避免每次请求都撞墙。
 */
async function robotsAllowed(url, timeoutMs) {
  if (process.env.DSH_WEBFETCH_IGNORE_ROBOTS === '1') return true
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const origin = u.origin
  let entry = ROBOTS_CACHE.get(origin)
  if (!entry || Date.now() - entry.at > ROBOTS_TTL_MS) {
    entry = { at: Date.now(), rules: [] }
    ROBOTS_CACHE.set(origin, entry)
    try {
      const meta = await fetchPage(`${origin}/robots.txt`, Math.min(timeoutMs, 8000), USER_AGENT, 'text')
      if (meta.status === 200) {
        const groups = meta.text.split(/\r?\n(?=user-agent:)/i)
        const group =
          groups.find((g) => /^user-agent:\s*dsh-webfetch/im.test(g)) ||
          groups.find((g) => /^user-agent:\s*\*/im.test(g)) ||
          ''
        entry.rules = group
          .split(/\r?\n/)
          .filter((l) => /^(allow|disallow):/i.test(l.trim()))
          .map((l) => {
            const m = /^(allow|disallow):\s*(\S*)/i.exec(l.trim())
            if (!m) return null
            let path
            try { path = decodeURIComponent(m[2]) } catch { path = m[2] } // 非法 % 序列不炸整个解析
            return { allow: m[1].toLowerCase() === 'allow', path }
          })
          .filter((r) => r && r.path !== '') // 空路径规则按 RFC 9309 视为无规则（全允许），必须跳过
      }
    } catch { /* robots 拿不到就当允许 */ }
  }
  const path = u.pathname + u.search
  let verdict = true
  let matched = -1
  for (const r of entry.rules) {
    if (!path.startsWith(r.path)) continue
    if (r.path.length > matched) {
      matched = r.path.length
      verdict = r.allow
    }
  }
  return verdict
}

// ---------- 结果渲染 ----------

function truncate(s, maxChars, startIndex) {
  if (s.length <= maxChars && startIndex === 0) return s
  // 越界时明确告知，而不是返回"前文已省略+空白"，否则模型会误以为还有下文。
  if (startIndex >= s.length) return `(startIndex=${startIndex} 已超出内容范围，全文共 ${s.length} 字符)`
  const chunk = s.slice(startIndex, startIndex + maxChars)
  const pre = startIndex > 0 ? `…（前文已省略，自第 ${startIndex} 字符起）\n` : ''
  const post = startIndex + maxChars < s.length ? `\n…（后文未显示，共 ${s.length} 字符，继续读请用 startIndex=${startIndex + maxChars}）` : ''
  return pre + chunk + post
}

function render(meta, format, maxChars, startIndex) {
  const type = meta.contentType.split(';')[0].trim().toLowerCase()
  const head = `URL: ${meta.finalUrl}\nstatus: ${meta.status} | content-type: ${meta.contentType || '(无)'} | bytes: ${meta.bytes}`
  const isHtml = type.startsWith('text/html') || type === 'application/xhtml+xml'
  const isText = type === '' || type.startsWith('text/') || isHtml || type === 'application/xml' || type === 'application/x-www-form-urlencoded'
  const wantJson = format === 'json' || type === 'application/json' || type.endsWith('+json')

  let body
  if (wantJson) {
    // JSON 接口直接格式化返回，解析失败就报错而不是悄悄吐原文——调用方有知情权。
    try {
      body = JSON.stringify(JSON.parse(meta.text), null, 2)
    } catch (e) {
      return { isError: true, text: `${head}\n\n响应不是合法 JSON：${e.message}\n原始前 400 字符：${truncate(meta.text, 400, 0)}` }
    }
  } else if (meta.bytes === 0) {
    body = '(空响应体)'
  } else if (format === 'html') {
    body = meta.text // 原样 HTML，不做任何清洗（OpenCode 的 raw 语义）
  } else if (isText) {
    if (isHtml) {
      const titleMatch = TITLE_RE.exec(meta.text)
      const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''
      const content = htmlToText(pickMainContent(meta.text), format === 'markdown', meta.finalUrl)
      body = (title ? `标题: ${title}\n\n` : '') + (content || '(页面无正文内容)')
    } else {
      body = meta.text.trim() || '(空响应体)'
    }
  } else {
    // 二进制：只回元信息，不把字节灌进模型上下文。
    body = `(二进制内容，类型 ${type}，不展开正文；需要下载请用其他方式)`
  }
  return { isError: false, text: `${head}\n\n${truncate(body, maxChars, startIndex)}` }
}

// ---------- 工具执行 ----------

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

async function callFetch(rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (!url) return { isError: true, text: '缺少必填参数 url' }

  // 只放行 http/https：file:// 之类的协议是安全边界，不碰。
  let parsed
  try { parsed = new URL(url) } catch { return { isError: true, text: `无效 URL：${url}` } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isError: true, text: `仅支持 http/https 协议，收到：${parsed.protocol}//` }
  }
  // SSRF 防护（pi 同款思路，取最关键几条）：云元数据服务与链路本地地址不可达。
  const host = parsed.hostname.toLowerCase()
  if (host === 'metadata.google.internal' || host === 'metadata' || host === '0.0.0.0' || host.startsWith('169.254.')) {
    return { isError: true, text: `出于安全考虑拒绝抓取该主机：${parsed.hostname}` }
  }

  const format = args.format === undefined ? 'text' : String(args.format)
  if (!['text', 'markdown', 'html', 'json'].includes(format)) {
    return { isError: true, text: `format 仅支持 text|markdown|html|json，收到：${format}` }
  }
  const maxChars = clampInt(args.maxChars, DEFAULT_MAX_CHARS, 1000, 200000)
  const startIndex = clampInt(args.startIndex, 0, 0, 10000000)
  const timeoutMs = clampInt(args.timeoutMs, DEFAULT_TIMEOUT_MS, 3000, 120000)

  log(`fetch url=${url} format=${format}`)
  try {
    // robots.txt 合规：被禁就直接拒绝，不偷偷抓。
    if (!(await robotsAllowed(url, timeoutMs))) {
      log('blocked by robots.txt')
      return { isError: true, text: `抓取被 robots.txt 禁止：${url}（如需忽略请设置 DSH_WEBFETCH_IGNORE_ROBOTS=1）` }
    }
    let meta = await fetchPage(url, timeoutMs, USER_AGENT, format)
    // Cloudflare 挑战：403 + cf-mitigated: challenge 时换透明 UA 重试一次（OpenCode 同款）。
    if (meta.status === 403 && (meta.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge') {
      log('cloudflare challenge, retrying with plain UA')
      meta = await fetchPage(url, timeoutMs, PLAIN_UA, format)
    }
    const result = render(meta, format, maxChars, startIndex)
    log(`done status=${meta.status} bytes=${meta.bytes}`)
    return result
  } catch (e) {
    const why = e.name === 'AbortError' ? `超时（${timeoutMs}ms）或连接被中断` : `${e.name}: ${e.message}`
    log(`fail ${why}`)
    return { isError: true, text: `抓取失败：${why}` }
  }
}

// ---------- JSON-RPC 2.0 核心 ----------

function respondError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

// 在途 tools/call 计数：stdin 关闭后要先等异步请求排空再退出，
// 否则一次性管道客户端（写完消息就关 stdin）会掐死在途响应。
let activeCalls = 0

/**
 * 处理一行 JSON-RPC 消息。respond 是回调而不是返回值，
 * 因为 tools/call 是异步的——同步分支直接回，异步分支完成后回。
 */
function handleMessage(line, respond) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    respond(respondError(null, -32700, 'Parse error'))
    return
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // 无 id 的非法消息是通知，按规范静默丢弃。
    if (msg && msg.id !== undefined) respond(respondError(msg.id, -32600, 'Invalid Request'))
    return
  }
  if (msg.id === undefined) return // notification：一律不回复

  const { id, method } = msg
  if (method === 'initialize') {
    const requested = msg.params && msg.params.protocolVersion
    // 客户端声明过且我们支持的版本才回显，否则给保守默认——和 SDK 服务端同款策略。
    const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
    respond({ jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO } })
    return
  }
  if (method === 'ping') {
    respond({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    respond({ jsonrpc: '2.0', id, result: { tools: [TOOL_DEF] } })
    return
  }
  if (method === 'tools/call') {
    activeCalls++
    callFetch(msg.params && msg.params.arguments)
      .then((r) => respond({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError === true } }))
      .catch((e) => respond(respondError(id, -32603, String(e && e.message || e))))
      .finally(() => { activeCalls-- })
    return
  }
  respond(respondError(id, -32601, `Method not found: ${method}`))
}

// ---------- stdio 传输 ----------

function startStdio() {
  log(`starting, pid=${process.pid}`)
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) {
        handleMessage(line, (resp) => {
          // 单行 JSON 写回；JSON.stringify 会转义字符串里的换行，保证协议行完整性。
          process.stdout.write(JSON.stringify(resp) + '\n')
        })
      }
    }
  })
  process.stdin.on('end', () => {
    log('stdin closed')
    // 宽限期：等最久 5 秒让在途调用排空；客户端（如 DSH）正常运行时
    // 不会关 stdin，这里只为一次性管道/关机场景兜底，避免悬挂。
    const deadline = setTimeout(() => {
      log('grace expired, forcing exit')
      process.exit(0)
    }, 5000)
    const drain = () => {
      if (activeCalls === 0) {
        clearTimeout(deadline)
        log('no pending calls, exiting')
        process.exit(0)
      } else {
        log(`waiting ${activeCalls} in-flight call(s)`)
        setTimeout(drain, 100)
      }
    }
    drain()
  })
}

module.exports = { handleMessage, callFetch, TOOL_DEF, htmlToText }
if (require.main === module) startStdio()
