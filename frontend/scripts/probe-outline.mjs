/**
 * 右栏「思维导图 / 大纲」的嵌套结构与节点属性冒烟。
 *
 * 覆盖：
 *   1. 导图是多层嵌套（层级 > 2），不是被压平的两层
 *   2. 节点带时间范围（起–止），分类节点不显示时间
 *   3. 大纲里每个节点铺出 1-2 句摘要，且能用「摘要」开关收起
 *   4. 大纲缩进能反映层级深度
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000，且有一个已分析完成、
 *      导图是多层结构的视频（重新分析过才有）。
 * 用法：node frontend/scripts/probe-outline.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = process.argv[2] || '锹农炮虫'

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
    // 折叠态看 data-expanded，不看行里有没有「▸」字符——
    // 三角已经换成 SVG，文本里不再有这个字
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

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(800)

// ---------------- A. 画布：多层 + 时间范围徽章 ----------------
console.log('\n[A] 画布：层级与时间范围')
const canvasNodes = await page.locator('.react-flow__node').count()
check('画布渲染节点', canvasNodes > 0, `${canvasNodes} 个`)

const badges = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')]
    .map((n) => n.textContent || '')
    .filter((t) => /\d+:\d\d/.test(t)),
)
const rangeBadges = badges.filter((t) => /\d+:\d\d–\d+:\d\d/.test(t))
check('节点徽章显示时间范围「起–止」', rangeBadges.length > 0, `${rangeBadges.length}/${badges.length} 个带范围`)
console.log(`  info 样例：${rangeBadges.slice(0, 3).join(' / ')}`)

// ---------------- B. 大纲：完整嵌套 + 摘要 ----------------
console.log('\n[B] 大纲：完整嵌套结构与摘要')
await page.getByRole('button', { name: '大纲', exact: true }).click()
await page.waitForTimeout(600)

const outline = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('div[style*="padding-left"]')].filter((d) =>
    d.className.includes('cursor-pointer'),
  )
  const depths = new Set()
  let summaries = 0
  for (const r of rows) {
    const pl = parseInt(r.style.paddingLeft, 10)
    if (Number.isFinite(pl)) depths.add(Math.round((pl - 4) / 16))
    if ([...r.children].some((c) => c.className.includes('text-[10.5px]'))) summaries += 1
  }
  return { rows: rows.length, depths: [...depths].sort((a, b) => a - b), summaries }
})
check('大纲渲染出节点行', outline.rows > 0, `${outline.rows} 行`)
check(
  '层级不止两层（未被压平）',
  outline.depths.length >= 3,
  `出现深度 ${outline.depths.join('/')}`,
)
check('节点带 1-2 句摘要', outline.summaries > 0, `${outline.summaries} 行有摘要`)

// 摘要开关
await page.getByRole('button', { name: '摘要', exact: true }).click()
await page.waitForTimeout(400)
const afterOff = await page.evaluate(
  () =>
    [...document.querySelectorAll('div[style*="padding-left"]')].filter(
      (d) =>
        d.className.includes('cursor-pointer') &&
        [...d.children].some((c) => c.className.includes('text-[10.5px]')),
    ).length,
)
check('「摘要」开关能收起摘要', afterOff === 0, `收起后剩 ${afterOff} 行带摘要`)
await page.getByRole('button', { name: '摘要', exact: true }).click()
await page.waitForTimeout(400)
const afterOn = await page.evaluate(
  () =>
    [...document.querySelectorAll('div[style*="padding-left"]')].filter(
      (d) =>
        d.className.includes('cursor-pointer') &&
        [...d.children].some((c) => c.className.includes('text-[10.5px]')),
    ).length,
)
check('再点一次恢复摘要', afterOn === outline.summaries, `${afterOn} 行`)

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
