/**
 * 章节卡里的「节点树」冒烟。
 *
 * 需求（2026-10-18）：章节下面每个卡要变成树形、可折叠可展开；
 * 树里的节点与大纲一一对应，但比大纲**详细**（多了该节点时间范围内的原文）。
 *
 * 覆盖：
 *   1. 每张章节卡里都铺出了节点行，且节点标签能在大纲里找到（一一对应）
 *   2. 卡头的三角能折叠/展开整棵树
 *   3. 节点自己的三角能折叠/展开它的子节点
 *   4. 点节点标题会跳播到该节点的时间
 *   5. 节点行**没有**「原文」按钮（2026-10-18 用户反馈「太细碎」后移除）
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-chapter-tree.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = '锹农炮虫'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] ?? (await browser.newContext())
const page = await context.newPage()
await page.setViewportSize({ width: 1440, height: 950 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

async function showTab(name) {
  const btn = page
    .locator('[data-panel="left"]')
    .getByRole('button', { name: new RegExp(`^${name}`) })
  if ((await btn.count()) > 0) {
    await btn.first().click()
    await page.waitForTimeout(250)
  }
}

async function openVideo(keyword) {
  await showTab('视频库')
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

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(1200)

// 大纲里的节点标签（用来验证「一一对应」）
await page.getByRole('button', { name: '大纲', exact: true }).click()
await page.waitForTimeout(600)
// 直接从后端拿树上的 label：比从 DOM 里剥时间徽章可靠得多
const apiLabels = await page.evaluate(async () => {
  const res = await fetch('/videomind/api/videos/2')
  const data = await res.json()
  const out = []
  const walk = (n) => {
    out.push((n.label || '').trim())
    for (const k of n.children || []) walk(k)
  }
  if (data.mindmap) walk(data.mindmap)
  return out
})
const outlineHasText = await page.evaluate(
  () => [...document.querySelectorAll('[data-node-id] button')].some((b) => b.textContent.trim() === '原文'),
)
check('大纲里也没有「原文」入口', !outlineHasText)

// ================= A. 章节卡里的节点树 =================
console.log('\n[A] 章节卡 → 节点树')
await showTab('章节')
await page.waitForTimeout(500)

const collect = () =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-panel="left"] [data-chapter-id]')]
    return cards.map((card) => ({
      id: card.getAttribute('data-chapter-id'),
      nodes: [...card.querySelectorAll('button[title^="跳到"]')].map((b) =>
        (b.textContent || '').trim(),
      ),
      textBtns: [...card.querySelectorAll('button')].filter((b) => b.textContent.trim() === '原文')
        .length,
    }))
  })
const cards = await collect()
const totalNodes = cards.reduce((n, c) => n + c.nodes.length, 0)
console.log(`  info ${cards.length} 张章节卡，共 ${totalNodes} 个节点行`)
check('章节卡里铺出了节点树', totalNodes > 0, `${totalNodes} 行`)
check('节点行不再有「原文」按钮（太细碎，已按用户要求移除）', cards.every((c) => c.textBtns === 0))
const missing = cards.flatMap((c) => c.nodes).filter((l) => !apiLabels.includes(l))
check(
  '节点与大纲一一对应（标签都能在后端那棵树上找到）',
  missing.length === 0 && totalNodes > 0,
  missing.slice(0, 3).join(' | '),
)

// ================= B. 整卡折叠 =================
console.log('\n[B] 章节卡折叠')
const firstCard = page.locator('[data-panel="left"] [data-chapter-id]').first()
const firstId = await firstCard.getAttribute('data-chapter-id')
const rowsBefore = await firstCard.locator('button[title^="跳到"]').count()
await firstCard.getByRole('button', { name: /^收起章节/ }).click()
await page.waitForTimeout(300)
const rowsCollapsed = await page
  .locator(`[data-panel="left"] [data-chapter-id="${firstId}"]`)
  .locator('button[title^="跳到"]')
  .count()
check('收起的卡片里节点树跟着收起', rowsBefore > 0 && rowsCollapsed === 0, `${rowsBefore} → ${rowsCollapsed}`)
await page
  .locator(`[data-panel="left"] [data-chapter-id="${firstId}"]`)
  .getByRole('button', { name: /^展开章节/ })
  .click()
await page.waitForTimeout(300)
const rowsBack = await page
  .locator(`[data-panel="left"] [data-chapter-id="${firstId}"]`)
  .locator('button[title^="跳到"]')
  .count()
check('再点能展开回来', rowsBack === rowsBefore, `${rowsBack} 行`)

// ================= C. 节点级折叠 =================
console.log('\n[C] 节点折叠')
// 先锁定「含分支节点的那张卡」，之后所有操作都在同一张卡里做——
// 用 filter 现找的话，收起一棵子树后 filter 命中的卡会变，按钮就找不到了
const branchCardId = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-panel="left"] [data-chapter-id]')]
  for (const c of cards) {
    const btn = [...c.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '收起子节点')
    if (btn) return c.getAttribute('data-chapter-id')
  }
  return null
})
const branchCard = page.locator(
  `[data-panel="left"] [data-chapter-id="${branchCardId}"]`,
)
const hasBranch = branchCardId !== null
if (hasBranch) {
  const before = await branchCard.locator('button[title^="跳到"]').count()
  await branchCard.locator('button[aria-label="收起子节点"]').first().click()
  await page.waitForTimeout(300)
  const after = await branchCard.locator('button[title^="跳到"]').count()
  check('节点三角能收起它的子树', after < before, `${before} → ${after}`)
  await branchCard.locator('button[aria-label="展开子节点"]').first().click()
  await page.waitForTimeout(300)
  const back = await branchCard.locator('button[title^="跳到"]').count()
  check('再点展开回来', back === before, `${back} 行`)
} else {
  check('找到可折叠的分支节点', false, '没有带子节点的节点')
}

// ================= D. 点节点跳播 =================
console.log('\n[D] 点节点跳播')
const jumpTarget = page
  .locator('[data-panel="left"] [data-chapter-id] button[title^="跳到"]')
  .nth(2)
const jumpTitle = (await jumpTarget.getAttribute('title')) || ''
await jumpTarget.click()
await page.waitForTimeout(1200)
const t = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1)
check('点节点标题后视频跳到该时间', jumpTitle.includes('跳到') && t > 0, `${jumpTitle} → ${t.toFixed(0)}s`)

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

// ================= F. 编辑框要够大 =================
console.log('\n[F] 章节编辑框')
await page.locator('[data-panel="left"] [data-chapter-id]').first().hover()
await page.waitForTimeout(200)
await page
  .locator('[data-panel="left"] [data-chapter-id]')
  .first()
  .getByRole('button', { name: '编辑', exact: true })
  .click()
await page.waitForTimeout(500)
const box = await page.evaluate(() => {
  const ta = document.querySelector('[data-panel="left"] textarea')
  const card = document.querySelector('[data-panel="left"] [data-chapter-id]')
  if (!ta || !card) return null
  const r = ta.getBoundingClientRect()
  return {
    h: Math.round(r.height),
    w: Math.round(r.width),
    cardW: Math.round(card.getBoundingClientRect().width),
    innerScroll: ta.scrollHeight > ta.clientHeight + 2,
  }
})
check('摘要框能装下整段内容（无内部滚动）', !!box && !box.innerScroll, JSON.stringify(box))
check('摘要框明显高于两行（≥120px）', !!box && box.h >= 120, `${box?.h}px`)
check('输入框吃满卡片宽度', !!box && box.w >= box.cardW - 24, `${box?.w}/${box?.cardW}`)

// 塞一段长文，确认它跟着长高而不是内部滚动
await page.evaluate(() => {
  const ta = document.querySelector('[data-panel="left"] textarea')
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  ).set
  setter.call(ta, (ta.value || '') + '追加一段用于验证自动长高的文字。'.repeat(12))
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(400)
const grown = await page.evaluate(() => {
  const ta = document.querySelector('[data-panel="left"] textarea')
  return {
    h: Math.round(ta.getBoundingClientRect().height),
    innerScroll: ta.scrollHeight > ta.clientHeight + 2,
  }
})
check('内容变多时摘要框自动长高', grown.h > (box?.h ?? 0), `${box?.h}px → ${grown.h}px`)
// 上限是 45vh（见 ChapterEditor 的 max-h）：超过就不再无限长高，改为框内滚动。
// 这里断言的是「会停住」，不是「永远不滚」——两者相反，写混了会把正确的行为判成失败。
const vh = await page.evaluate(() => window.innerHeight)
check(
  '长高有上限（不超过 45vh）',
  grown.h <= vh * 0.46 + 2,
  `${grown.h}px / 视口 ${vh}px`,
)

// 取消，别把测试内容存进库里
await page.getByRole('button', { name: '取消', exact: true }).first().click()
await page.waitForTimeout(300)

await page.locator('[data-panel="left"]').screenshot({
  path: 'J:/AIProject/RealVideoWebSite/.probe/chapter-tree.png',
})
await page.close()
console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
