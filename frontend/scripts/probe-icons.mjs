/**
 * 图标 / 按钮尺寸的回归冒烟。
 *
 * 背景：videomind 里原先混用 emoji 和字符当图标（📁 ▸ ✕ ＋ ↑ ⌨ ▶），
 * 实测分类行的操作按钮只有 13×16、大纲折叠三角 14×9——都低于
 * WCAG 2.2 要求的 24×24 最小目标尺寸，鼠标都要瞄着点。
 * 这一版把它们全换成内联 SVG，并统一触控区；本脚本就是防止再退回去。
 *
 * 覆盖：
 *   1. 页面上所有可见按钮的触控区不小于 24×24（例外名单需显式登记）
 *   2. 图标按钮必须有无障碍名称（aria-label 或可见文字）
 *   3. 装饰性 SVG 一律 aria-hidden，不污染读屏
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-icons.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const SHOT_DIR = 'J:/AIProject/RealVideoWebSite/.probe'
const MIN = 24

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] ?? (await browser.newContext())
const page = await context.newPage()
await page.setViewportSize({ width: 1500, height: 950 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

async function openVideo(keyword) {
  for (let pass = 0; pass < 6; pass += 1) {
    await page.evaluate(() => {
      for (const r of document.querySelectorAll('[data-panel="left"] [data-folder-row][data-expanded="false"]')) {
        r.click()
      }
    })
    await page.waitForTimeout(250)
    const rows = page.locator('[data-panel="left"] .cursor-pointer')
    const total = await rows.count()
    for (let i = 0; i < total; i += 1) {
      const t = await rows.nth(i).innerText().catch(() => '')
      if (t.includes(keyword)) {
        await rows.nth(i).click()
        return true
      }
    }
  }
  return false
}

/** 量当前页面所有可见按钮，返回不合规清单 */
const audit = () =>
  page.evaluate((MIN) => {
    const out = { total: 0, small: [], nameless: [], loud: [] }
    for (const b of document.querySelectorAll('button')) {
      const r = b.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(b)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      // 画布里的节点会随 zoom 整体缩放，量出来的是缩放后的尺寸，
      // 与「触控区设计尺寸」不是一回事，跳过
      if (b.closest('.react-flow__viewport')) continue
      out.total += 1
      const name = (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)
      // 容差 0.5px：本机显示缩放 137% 时 Chrome 量出的尺寸是 23.996 而非 24
      if (r.width < MIN - 0.5 || r.height < MIN - 0.5) {
        out.small.push({
          name,
          w: Math.round(r.width),
          h: Math.round(r.height),
          cls: b.className.slice(0, 60),
        })
      }
      if (!name) out.nameless.push(b.className.slice(0, 60))
    }
    // 装饰性 SVG 必须 aria-hidden，否则读屏会读出一堆无意义的图形。
    // ReactFlow 自己的连线/控件 SVG 不在本次治理范围内，跳过
    for (const s of document.querySelectorAll('svg')) {
      if (s.closest('.react-flow')) continue
      if (s.getAttribute('aria-hidden') !== 'true' && !s.getAttribute('aria-label')) {
        out.loud.push(s.getAttribute('class') || s.outerHTML.slice(0, 40))
      }
    }
    return out
  }, MIN)

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('打开 video-mind', (await page.locator('text=video-mind').count()) > 0)

const opened = await openVideo('锹农炮虫')
check('点开带导图与章节的视频', opened)
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(1000)

// ================= A. 主界面按钮尺寸 =================
console.log('\n[A] 主界面所有按钮的触控区')
const main = await audit()
console.log(`  info 共 ${main.total} 个可见按钮`)
for (const s of main.small) console.log(`       ${s.w}×${s.h}  ${s.name || '(无名称)'}  ${s.cls}`)
check(
  `所有按钮不小于 ${MIN}×${MIN}`,
  main.small.length === 0,
  main.small.length ? `${main.small.length} 个偏小` : '',
)
check('所有按钮都有可访问名称', main.nameless.length === 0, main.nameless.slice(0, 2).join(' | '))
check('装饰性 SVG 全部 aria-hidden', main.loud.length === 0, main.loud.slice(0, 2).join(' | '))

// ================= B. 大纲视图 =================
console.log('\n[B] 大纲视图')
await page.getByRole('button', { name: '大纲', exact: true }).click()
await page.waitForTimeout(600)
const outline = await audit()
for (const s of outline.small) console.log(`       ${s.w}×${s.h}  ${s.name || '(无名称)'}  ${s.cls}`)
check(`大纲视图按钮不小于 ${MIN}×${MIN}`, outline.small.length === 0, `共 ${outline.total} 个按钮`)
const tri = await page
  .locator('button[aria-label="折叠"], button[aria-label="展开"]')
  .first()
  .boundingBox()
check(
  '大纲折叠三角达到 24×24',
  !!tri && tri.width >= MIN - 0.5 && tri.height >= MIN - 0.5,
  tri ? `${Math.round(tri.width)}×${Math.round(tri.height)}` : '未找到',
)
mkdirSync(SHOT_DIR, { recursive: true })
await page.screenshot({ path: SHOT_DIR + '/videomind-outline.png' })
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(400)

// ================= C. 弹窗里的关闭按钮 =================
console.log('\n[C] 弹窗')
for (const [name, file] of [
  ['用量', 'usage'],
  ['设置', 'settings'],
]) {
  await page.getByRole('button', { name, exact: true }).first().click()
  await page.waitForTimeout(500)
  const modal = await audit()
  const small = modal.small
  for (const s of small) console.log(`       ${s.w}×${s.h}  ${s.name || '(无名称)'}  ${s.cls}`)
  check(`「${name}」弹窗按钮不小于 ${MIN}×${MIN}`, small.length === 0)
  await page.screenshot({ path: `${SHOT_DIR}/videomind-${file}.png` })
  await page.getByRole('button', { name: '关闭' }).first().click()
  await page.waitForTimeout(300)
}

// ================= D. 侧栏折叠后的窄条 =================
console.log('\n[D] 侧栏折叠窄条')
await page.locator('button[aria-label="折叠左侧栏"]').first().click()
await page.waitForTimeout(400)
const rail = await page.locator('button[aria-label="展开视频库"]').first().boundingBox()
check(
  '左栏窄条按钮不小于 24×24',
  !!rail && rail.width >= MIN && rail.height >= MIN,
  rail ? `${Math.round(rail.width)}×${Math.round(rail.height)}` : '未找到',
)
await page.locator('button[aria-label="展开视频库"]').first().click()
await page.waitForTimeout(300)

// ================= E. 分类行的操作按钮 =================
console.log('\n[E] 分类行操作按钮')
const row = page.locator('[data-panel="left"] [data-folder-row]').nth(1)
await row.hover()
await page.waitForTimeout(300)
for (const label of ['在此分类下新建子分类', '重命名', '删除分类']) {
  const b = await page.locator(`button[aria-label="${label}"]`).first().boundingBox()
  // 亚像素：h-6 在 flex 里偶尔量出 23.99，留 0.5px 容差
  const ok = !!b && b.width >= MIN - 0.5 && b.height >= MIN - 0.5
  check(
    `「${label}」按钮 24×24`,
    ok,
    b ? `${b.width.toFixed(2)}×${b.height.toFixed(2)}` : '未找到',
  )
}

// ================= F. 同一排控件的对齐 =================
// 「图标大小不合适」之外的另一半问题是摆放：同一排按钮高矮不一、
// 图标和文字不在同一条基线上，一眼看上去就是乱的。
console.log('\n[F] 同排控件的对齐')
const groups = await page.evaluate(() => {
  const out = []
  // strict=false 的组只查中线：分类行里的图标/标题/计数是文本与装饰，
  // 高度本来就不一样，要求它们等高没有意义，只要在同一条中线上即可
  const measure = (name, els, strict = true) => {
    const bs = [...els].map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0)
    if (bs.length < 2) return
    const rng = (xs) => Math.max(...xs) - Math.min(...xs)
    out.push({
      name,
      strict,
      n: bs.length,
      h: Math.round(rng(bs.map((b) => b.height)) * 100) / 100,
      top: Math.round(rng(bs.map((b) => b.top)) * 100) / 100,
      mid: Math.round(rng(bs.map((b) => b.top + b.height / 2)) * 100) / 100,
    })
  }
  const bar = document.querySelector('button[title^="重命名选中节点"]')?.parentElement
  if (bar) measure('节点操作条', bar.querySelectorAll('button'))
  const pl = document.querySelector('button[title="后退 10 秒"]')?.parentElement
  if (pl) measure('播放器控制条', pl.querySelectorAll('button'))
  const tools = document.querySelector('button[title="操作说明"]')?.parentElement
  if (tools) measure('搜索/工具条', tools.querySelectorAll('button, input'))
  const tabs = document.querySelector('button[aria-label="折叠右侧栏"]')?.parentElement
  if (tabs) measure('右栏标签页', tabs.querySelectorAll('button'))

  // 分类行内部：图标 / 标题 / 计数 要在同一条中线上
  const row = document.querySelector('[data-panel="left"] [data-folder-row]')
  if (row) {
    const parts = [...row.children].filter((c) => c.getBoundingClientRect().height > 0)
    measure('分类行内部', parts, false)
  }
  return out
})
for (const g of groups) {
  console.log(`  info ${g.name}：${g.n} 个 · 高度差 ${g.h}px · 顶边差 ${g.top}px · 中线差 ${g.mid}px`)
}
const strict = groups.filter((g) => g.strict)
check(
  '同排控件高度一致（差 < 1px）',
  strict.every((g) => g.h < 1),
  strict.filter((g) => g.h >= 1).map((g) => `${g.name}(${g.h}px)`).join('、'),
)
check(
  '同排控件顶边对齐（差 < 1px）',
  strict.every((g) => g.top < 1),
  strict.filter((g) => g.top >= 1).map((g) => `${g.name}(${g.top}px)`).join('、'),
)
check(
  '同行元素中线对齐（差 < 1.5px）',
  groups.every((g) => g.mid < 1.5),
  groups.filter((g) => g.mid >= 1.5).map((g) => `${g.name}(${g.mid}px)`).join('、'),
)

await page.screenshot({ path: SHOT_DIR + '/videomind-main.png' })

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
