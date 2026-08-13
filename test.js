'use strict'
/**
 * server.js 的进程内测试：直接调 handleMessage，不经 stdio 管道，
 * 避免沙箱下子进程 stdio 管道的 EPERM 边界，同时逻辑覆盖面完全一致。
 * 本地 HTTP 服务器测试全部管线不依赖外网；外网用例失败只警告不判败。
 */
const http = require('http')
const { handleMessage } = require('./server.js')

function roundtrip(msg, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
    handleMessage(JSON.stringify(msg), (resp) => {
      clearTimeout(timer)
      resolve(resp)
    })
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

function call(args, id = 100) {
  return roundtrip({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fetch', arguments: args } })
}
function textOf(r) {
  return (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || ''
}

(async () => {
  // ===== 协议层 =====
  let r = await roundtrip({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  check('initialize 回显协议版本', r.result?.protocolVersion === '2025-06-18' && r.result?.serverInfo?.name === 'dsh-webfetch')
  r = await roundtrip({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: {} } })
  check('initialize 未知版本回落', r.result?.protocolVersion === '2025-03-26')
  r = await roundtrip({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const schema = r.result?.tools?.[0]?.inputSchema?.properties || {}
  check('tools/list 只有 fetch 且含新参数', r.result?.tools?.map((t) => t.name).join() === 'fetch' && !!schema.startIndex && schema.format.enum.join() === 'text,markdown,html,json')
  let notified = false
  handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), () => { notified = true })
  check('notification 不回复', notified === false)
  handleMessage('{bad json', (resp) => { check('非法 JSON 行返回 -32700', resp.error?.code === -32700 && resp.id === null) })
  r = await roundtrip({ jsonrpc: '2.0', id: 6, method: 'resources/list' })
  check('未知方法 -32601', r.error?.code === -32601)

  // ===== 参数校验与 SSRF =====
  r = await call({})
  check('缺 url 报错', r.result?.isError === true)
  r = await call({ url: 'file:///C:/Windows/win.ini' })
  check('file:// 协议被拒', r.result?.isError === true && textOf(r).includes('仅支持 http/https'))
  r = await call({ url: 'https://x.test/', format: 'yaml' })
  check('非法 format 报错', r.result?.isError === true)
  r = await call({ url: 'http://169.254.169.254/latest/meta-data/' })
  check('SSRF：链路本地地址被拒', r.result?.isError === true && textOf(r).includes('安全考虑'))
  r = await call({ url: 'http://metadata.google.internal/' })
  check('SSRF：云元数据被拒', r.result?.isError === true && textOf(r).includes('安全考虑'))

  // ===== 本地 HTTP 服务器 =====
  const seen = { ua: {}, accept: {} }
  // 真实页面结构：标题/导语/链接/图片都在 article 内部，导航噪声在外部
  const bigArticle =
    '<article>' +
    '<h1>标题一</h1>' +
    '<p>第一段 <a href="/rel">链接A</a> <img src="/i.png" alt="图甲"> 内容。</p>' +
    '<p><a href=/unquoted>裸链接</a> <a href="/logo"><img src="/logo.png" alt="站点logo"></a></p>' +
    '<p>第二段 &amp; 实体 &#x1F600;</p>' +
    '<p>正文内容甲乙丙丁。</p>'.repeat(400) +
    '</article>'
  const navNoise = '<nav>' + '导航噪声一二三。'.repeat(3) + '</nav>'
  const sample = `<!DOCTYPE html><html><head><title>测试页</title><style>.x{color:red}</style></head><body>
  ${navNoise}<script>var evil=1;</script>
  ${bigArticle}</body></html>`
  let cfHits = 0
  const longBody = '长文内容。'.repeat(1200) // 约 6000 字符
  const server = http.createServer((req, res) => {
    seen.ua[req.url] = req.headers['user-agent'] || ''
    seen.accept[req.url] = req.headers.accept || ''
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('User-agent: *\nDisallow: /private\n')
    } else if (req.url.startsWith('/private/')) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<html><body>秘密内容不应被返回</body></html>')
    } else if (req.url === '/cf') {
      cfHits++
      if (cfHits === 1) {
        res.statusCode = 403
        res.setHeader('cf-mitigated', 'challenge')
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<html><body>Just a moment...</body></html>')
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<html><body>挑战通过，正常内容</body></html>')
      }
    } else if (req.url === '/json') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }))
    } else if (req.url === '/long') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<html><head><title>长文</title></head><body>${longBody}</body></html>`)
    } else if (req.url === '/echo') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ accept: req.headers.accept, ua: req.headers['user-agent'] }))
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(sample)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  // ===== HTML 清洗与正文优先 =====
  r = await call({ url: base + '/' })
  let t = textOf(r)
  check('清洗：无 script/style', !t.includes('evil') && !t.includes('.x{'))
  check('清洗：保留标题与正文', t.includes('标题: 测试页') && t.includes('标题一') && t.includes('第一段'))
  check('清洗：实体解码', t.includes('& 实体 😀'))
  check('正文优先：main/article 命中后无导航噪声', t.includes('正文内容甲乙丙丁') && !t.includes('导航噪声'))

  // ===== markdown：链接绝对化 + 图片 alt =====
  r = await call({ url: base + '/', format: 'markdown' })
  t = textOf(r)
  check('markdown：相对链接绝对化', t.includes(`[链接A](${base}/rel)`), t.split('\n').find((l) => l.includes('链接A')) || '')
  check('markdown：图片转 ![alt](绝对URL)', t.includes(`![图甲](${base}/i.png)`))
  check('markdown：无引号 href 也能绝对化', t.includes(`[裸链接](${base}/unquoted)`))
  check('markdown：图片型链接用 alt 当文本', t.includes(`[站点logo](${base}/logo)`))
  check('markdown：标题保留', t.includes('# 标题一'))

  // ===== html 原样 / JSON / 截断 / 分块 =====
  r = await call({ url: base + '/', format: 'html', maxChars: 3000 })
  t = textOf(r)
  check('html 格式原样返回', t.includes('<nav') || t.includes('<article'))
  r = await call({ url: base + '/json' })
  t = textOf(r)
  check('JSON 自动格式化', !r.result?.isError && t.includes('"items": [\n    1,'))

  r = await call({ url: base + '/long', maxChars: 1000 })
  t = textOf(r)
  check('分块第一片：有后文标记', t.includes('后文未显示') && t.includes('startIndex=1000'))
  const firstLen = t.length
  r = await call({ url: base + '/long', maxChars: 1000, startIndex: 1000 })
  t = textOf(r)
  check('分块第二片：有前文标记且长度相近', t.includes('自第 1000 字符起') && Math.abs(t.length - firstLen) < 120)
  r = await call({ url: base + '/long', maxChars: 1000, startIndex: 10000 })
  t = textOf(r)
  check('startIndex 超界：明确越界提示', t.includes('已超出内容范围') && !t.includes('后文未显示'))

  // ===== robots.txt =====
  r = await call({ url: base + '/private/page' })
  check('robots：Disallow 路径被拒', r.result?.isError === true && textOf(r).includes('robots.txt'))
  r = await call({ url: base + '/public/page' })
  check('robots：允许路径放行', !r.result?.isError)

  // 空 Disallow（RFC 9309 语义=全允许）与 Disallow: /（全封）各用一个独立 origin，避开缓存
  const mk = (robotsText, bodyText) =>
    new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.url === '/robots.txt') {
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(robotsText)
        } else {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(`<html><body>${bodyText}</body></html>`)
        }
      })
      s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }))
    })
  const emptyDisallow = await mk('User-agent: *\nDisallow:\n', '应该放行')
  r = await call({ url: emptyDisallow.base + '/page' })
  check('robots：空 Disallow 视为全允许', !r.result?.isError && textOf(r).includes('应该放行'))
  emptyDisallow.s.close()
  const slashDisallow = await mk('User-agent: *\nDisallow: /\n', '不该放行')
  r = await call({ url: slashDisallow.base + '/page' })
  check('robots：Disallow / 全封', r.result?.isError === true && textOf(r).includes('robots.txt'))
  slashDisallow.s.close()

  // ===== Cloudflare 挑战重试 =====
  r = await call({ url: base + '/cf' })
  t = textOf(r)
  check('CF 挑战：自动换 UA 重试成功', cfHits === 2 && t.includes('挑战通过') && !r.result?.isError)
  check('CF 重试使用了不同 UA', seen.ua['/cf'] === 'dsh-webfetch/1.1 (+https://harness.deepseek.com)')

  // ===== Accept 头按格式 =====
  await call({ url: base + '/echo', format: 'markdown' })
  check('Accept：markdown 格式请求 markdown 优先', (seen.accept['/echo'] || '').startsWith('text/markdown'))

  server.close()

  // ===== 外网探活（失败仅警告）=====
  try {
    r = await call({ url: 'https://example.com/', timeoutMs: 15000 })
    console.log(`WARN  外网 example.com：${r.result?.isError ? '失败(' + textOf(r).slice(0, 80) + ')' : '成功'}`)
  } catch (e) {
    console.log(`WARN  外网用例异常：${e.message}`)
  }

  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('测试运行异常：', e)
  process.exit(1)
})
