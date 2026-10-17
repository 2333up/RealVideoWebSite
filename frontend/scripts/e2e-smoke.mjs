/**
 * 端到端冒烟：合并后的单一应用（灵搜 + video-mind 同端口路由分流）。
 *
 * 覆盖 AGENTS.md 自检清单中「改到哪个平台就实跑一次对应搜索/详情接口」的要求，
 * 重点验收 B 站详情浮层移除屏蔽控件逻辑后的现状（两种视图按原样呈现）。
 *
 * 已知站方行为（2026-10-17 实测）：代理页面加载约 2-4s 后，B 站的反嵌入脚本会把
 * iframe 导航到真实域名 www.bilibili.com（帧树可证），此后为游客态、推荐栏全在。
 * 服务端注入对这一刻之后的页面无能为力——这正是移除屏蔽逻辑的依据。
 * 故本脚本只断言「初始代理页渲染出真实标题」，导航本身仅记录不判失败。
 *
 * 前置：一个带 CDP 的浏览器实例（本机没有 Playwright 自带 chromium 时，
 * 用 puppeteer 缓存的 chrome 或 Edge 均可）：
 *   chrome --remote-debugging-port=9222 --headless=new --user-data-dir=<tmp> about:blank
 *
 * 用法：node frontend/scripts/e2e-smoke.mjs
 * （playwright-core 由脚本内 createRequire 指向 workspace，无需 NODE_PATH）
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] ?? (await browser.newContext())
const page = await context.newPage()
await page.setViewportSize({ width: 1360, height: 900 })

// 切换清晰度不应再产生 playurl 请求——档位信息在打开弹窗时已一次拿全
let playurlCalls = 0
page.on('request', (r) => {
  if (r.url().includes('/platforms/bilibili/playurl')) playurlCalls += 1
})

// 纯净版播放器（player.bilibili.com）的响应码，切视图后断言
let playerStatus = 0
page.on('response', (r) => {
  if (r.url().includes('player.bilibili.com') && playerStatus === 0) playerStatus = r.status()
})

// ================= A. 灵搜：首页 + 真实 B 站搜索 =================
console.log('\n[A] 灵搜首页与真实搜索')
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
const title = await page.title()
check('标题为灵搜', title.includes('灵搜'), title)
const tag = page.getByRole('button', { name: 'Python教程' })
check('空态关键词标签可点', (await tag.count()) > 0)
await tag.first().click()
try {
  await page.waitForSelector('a[href*="bilibili.com/video/"]', { timeout: 30000 })
  const cards = await page.locator('a[href*="bilibili.com/video/"]').count()
  check('B 站真实搜索结果渲染', cards > 0, `${cards} 张卡片`)
} catch {
  check('B 站真实搜索结果渲染', false, '30s 内无卡片')
}

// ================= B. 详情浮层（本次改动对象） =================
console.log('\n[B] B 站视频详情浮层')
let modalReady = false
try {
  await page.locator('a[href*="bilibili.com/video/"]').first().click()
  await page.waitForSelector('iframe', { timeout: 20000 })
  modalReady = true
} catch { /* 下面统一报错 */ }
check('点击卡片打开浮层', modalReady)
if (modalReady) {
  await page.waitForTimeout(2500)
  check('「加强过滤」按钮已移除', (await page.getByText('加强过滤').count()) === 0)
  check('清理状态栏已移除', (await page.getByText(/已清理 \d+ 个元素/).count()) === 0)
  const src = await page.locator('iframe').first().getAttribute('src')
  check('嵌入视图走服务端代理', !!src && src.includes('/api/platforms/bilibili/embed'), src || '无 src')
  // 初始加载的是代理页面（同源可读）；B 站反嵌入脚本会在数秒内把 iframe 导航到
  // 真实域名（见文件头已知行为），故用 300ms 快轮询抢在导航前读到真实标题
  let frameTitle = ''
  try {
    await page.waitForFunction(
      () => {
        const f = document.querySelector('iframe')
        const d = f && f.contentDocument
        return !!d && !!d.title
      },
      { timeout: 8000, polling: 300 }
    )
    frameTitle = await page.evaluate(
      () => (document.querySelector('iframe')?.contentDocument?.title) || ''
    )
  } catch { /* 8s 内没读到标题才判失败 */ }
  check('iframe 初始加载真实 B 站页面（代理态）', frameTitle.length > 0, frameTitle || '8s 内未读到标题')
  const navigated = page.frames().some((f) => f.url().startsWith('https://www.bilibili.com/'))
  console.log(`  info B 站反嵌入导航已${navigated ? '发生（已知行为）' : '未发生'}`)

  // 切「纯净版」：代理页 iframe 应退场，官方播放器 iframe 应入场
  const clean = page.getByText('纯净版', { exact: true })
  if ((await clean.count()) > 0) {
    await clean.first().click()
    await page.waitForTimeout(1500)
    const proxyIframes = await page.locator('iframe[src*="/api/platforms/bilibili/embed"]').count()
    const playerIframes = await page.locator('iframe[src*="player.bilibili.com"]').count()
    check('纯净版：代理页 iframe 退场', proxyIframes === 0, `剩 ${proxyIframes} 个`)
    check('纯净版：官方播放器入场', playerIframes > 0, `${playerIframes} 个`)
    check('纯净版：播放器资源 200', playerStatus === 200, `status=${playerStatus || '未捕获'}`)
    const h2 = await page.locator('h2').first().textContent().catch(() => '')
    check('纯净版：自绘详情标题可见', (h2 || '').trim().length > 0, (h2 || '').trim().slice(0, 30))
  } else {
    check('纯净版切换按钮存在', false)
  }
  // 关闭浮层
  const closer = page.locator('button[aria-label="关闭"]').first()
  if ((await closer.count()) > 0) {
    await closer.click()
    await page.waitForTimeout(800)
    check('关闭按钮可关闭浮层', (await page.locator('button[aria-label="关闭"]').count()) === 0)
  }
}

// ================= C. video-mind：合并后冒烟 =================
console.log('\n[C] video-mind 路由与导图')
await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
const rows = await page.locator('aside div.cursor-pointer').count()
check('视频列表渲染', rows > 0, `${rows} 行`)
let openedTitle = ''
try {
  openedTitle = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('aside div.cursor-pointer')]
    const r = rs.find((x) => x.textContent.includes('已完成')) ?? rs[0]
    if (!r) return ''
    const t = r.querySelector('.truncate')?.textContent ?? ''
    r.click()
    return t
  })
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  const nodes = await page.locator('.react-flow__node').count()
  check('点开视频并渲染思维导图', nodes > 0, `${nodes} 节点`)
} catch {
  check('点开视频并渲染思维导图', false, openedTitle || '列表为空或点击失败')
}

// ================= D. 下载画质档位（MP4 直链上限 720P，1080P 需合并） =================
// 另起一轮：B 段结尾已把浮层关掉，直接 goto 重置状态最干净
console.log('\n[D] 下载画质档位')
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Python教程' }).first().click()
await page.waitForSelector('a[href*="bilibili.com/video/"]', { timeout: 30000 })
await page.locator('a[href*="bilibili.com/video/"]').first().click()
await page.waitForSelector('iframe', { timeout: 20000 })
await page.getByRole('button', { name: /下载/ }).first().click()
await page.waitForSelector('text=已选清晰度', { timeout: 40000 })
const q1080 = page.getByRole('button', { name: /1080P/ })
const has1080 = (await q1080.count()) > 0
const label1080 = has1080 ? (await q1080.first().innerText()).replace(/\s+/g, ' ') : ''
check('下载弹窗出现 1080P（标「合并」）', has1080 && label1080.includes('合并'), label1080 || '未出现')
check('1080P 档位可用（服务端有 ffmpeg）', has1080 ? await q1080.first().isEnabled() : false)

// 切换清晰度是纯状态变更：档位信息已在打开弹窗时一次拿全，
// 真正的下载地址由下载接口按 qn 现取，故不应再有 playurl 往返
const callsBefore = playurlCalls
if (has1080) {
  await q1080.first().click()
  await page.waitForTimeout(1500)
  check('切换清晰度不再重新请求 playurl', playurlCalls === callsBefore, `新增 ${playurlCalls - callsBefore} 次`)
  const picked = await page.getByText(/已选清晰度/).first().innerText()
  check('已选清晰度实时更新', picked.includes('1080P'), picked.replace(/\s+/g, ' ').slice(0, 40))
}

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
// 不调 browser.close()：CDP 连接的另一端是后台任务里的浏览器，退出进程自然断开
process.exit(failures === 0 ? 0 : 1)
