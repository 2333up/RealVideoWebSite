/**
 * 右侧「逐字稿」面板的冒烟。
 *
 * 需求（2026-10-18）：逐字稿**默认展开**——以前默认收起，切到 tab 还要再点一次
 * 「展开逐字稿（N 段）」，而收起态下「跟随播放滚动」也不生效。
 *
 * 覆盖：
 *   1. 切到逐字稿 tab 就直接看到段落（没有「展开逐字稿」按钮）
 *   2. 列表吃满面板高度（不是写死 420px）
 *   3. 点某一段能跳播到它的时间
 *   4. 搜索能过滤并高亮
 *   5. 「收起 / 展开」仍可来回切
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-transcript.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
/** 用民法那支：2871 段，最长，最能暴露性能与滚动问题 */
const KEYWORD = '民法'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] ?? (await browser.newContext())
const page = await context.newPage()
await page.setViewportSize({ width: 1600, height: 1000 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

async function openVideo(keyword) {
  for (let pass = 0; pass < 8; pass += 1) {
    await page.evaluate(() => {
      for (const r of document.querySelectorAll(
        '[data-panel="left"] [data-folder-row][data-expanded="false"]',
      )) {
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

const state = () =>
  page.evaluate(() => {
    const p = document.querySelector('[data-panel="right"]')
    const rows = [...p.querySelectorAll('div.cursor-pointer')]
    const box = [...p.querySelectorAll('div')].find((d) => (d.className || '').includes('overflow-y-auto'))
    return {
      rows: rows.length,
      collapsed: [...p.querySelectorAll('button')].some((b) =>
        (b.textContent || '').includes('展开逐字稿'),
      ),
      search: !!p.querySelector('input[placeholder="搜索内容…"]'),
      marks: p.querySelectorAll('mark').length,
      boxH: box ? Math.round(box.getBoundingClientRect().height) : 0,
      panelH: Math.round(p.getBoundingClientRect().height),
    }
  })

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开长视频', await openVideo(KEYWORD))
await page.waitForTimeout(2000)

// ================= A. 默认展开 =================
console.log('\n[A] 默认展开')
await page.locator('[data-panel="right"]').getByRole('button', { name: '逐字稿', exact: true }).click()
await page.waitForTimeout(900)
const a = await state()
console.log('  info', JSON.stringify(a))
check('切过去就有段落，不用再点一次', a.rows > 100, `${a.rows} 段`)
check('没有「展开逐字稿」按钮（说明已是展开态）', !a.collapsed)
check('搜索框直接可用', a.search)
check(
  '列表吃满面板高度（不再是写死 420px）',
  a.boxH > a.panelH * 0.6,
  `列表 ${a.boxH}px / 面板 ${a.panelH}px`,
)

// ================= B. 点一段跳播 =================
console.log('\n[B] 点段落跳播')
const clicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-panel="right"] div.cursor-pointer')]
  const row = rows[5]
  if (!row) return null
  const label = (row.querySelector('span')?.textContent || '').trim()
  row.click()
  return label
})
await page.waitForTimeout(1000)
const t = await page.evaluate(() => Math.round(document.querySelector('video')?.currentTime ?? -1))
check('点第 6 段后视频跳到该时间', !!clicked && t > 0, `${clicked} → ${t}s`)

// ================= C. 搜索过滤与高亮 =================
console.log('\n[C] 搜索')
await page.evaluate(() => {
  const input = document.querySelector('[data-panel="right"] input[placeholder="搜索内容…"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '合同')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(500)
const c = await state()
check('搜索能过滤', c.rows > 0 && c.rows < a.rows, `${a.rows} → ${c.rows} 段`)
check('命中处高亮', c.marks > 0, `${c.marks} 处 mark`)

// ================= D. 收起 / 展开 =================
console.log('\n[D] 收起再展开')
await page.evaluate(() => {
  const input = document.querySelector('[data-panel="right"] input[placeholder="搜索内容…"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(300)
await page.locator('[data-panel="right"]').getByRole('button', { name: '收起', exact: true }).click()
await page.waitForTimeout(300)
const d1 = await state()
check('点「收起」后列表消失', d1.rows === 0 && d1.collapsed, `${d1.rows} 段`)
await page
  .locator('[data-panel="right"]')
  .getByRole('button', { name: /^展开逐字稿/ })
  .click()
await page.waitForTimeout(500)
const d2 = await state()
check('再展开能回来', d2.rows === a.rows, `${d2.rows} 段`)

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await page.locator('[data-panel="right"]').screenshot({
  path: 'J:/AIProject/RealVideoWebSite/.probe/transcript-expanded.png',
})
await page.close()
console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
