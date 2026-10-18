/**
 * 章节摘要「被裁掉时必须能展开」的冒烟。
 *
 * 背景（2026-10-18 用户反馈）：章节摘要被 line-clamp 限制成两行，
 * 又没有任何展开入口，长摘要等于被锁死在两行里读不完。
 *
 * 覆盖：
 *   1. 被裁的摘要会显示「展开全文」；没被裁的不显示（不拿长度猜，按真实溢出量判断）
 *   2. 点「展开全文」后全文可见，「收起」按钮出现
 *   3. 展开/收起都不会顺带跳播（整张章节卡是跳播热区）
 *   4. 点「收起」回到两行
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-chapter-summary.mjs
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
await page.setViewportSize({ width: 1360, height: 900 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

/** 切左栏 tab（章节现在和视频库共用左栏） */
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
  for (let pass = 0; pass < 6; pass += 1) {
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
check('点开带章节的视频', await openVideo(KEYWORD))
await page.waitForTimeout(1500)
await showTab('章节')
await page.waitForTimeout(400)

// ================= A. 被裁的摘要给出展开入口 =================
console.log('\n[A] 裁切与展开入口')
const cards = await page.evaluate(() => {
  const out = []
  for (const card of document.querySelectorAll('[data-panel="left"] [data-chapter-id]')) {
    const p = card.querySelector('p')
    if (!p) continue
    const btn = [...card.querySelectorAll('button')].find((b) =>
      /展开全文|收起/.test(b.textContent || ''),
    )
    out.push({
      id: card.getAttribute('data-chapter-id'),
      // 溢出量 > 1px 才算真的被裁（浏览器会有亚像素误差）
      clipped: p.scrollHeight > p.clientHeight + 1,
      hasBtn: !!btn,
      btnText: btn ? (btn.textContent || '').trim() : '',
      lines: Math.round(p.clientHeight / 22),
    })
  }
  return out
})
console.log('  info', JSON.stringify(cards))
check('章节卡上能找到摘要', cards.length > 0, `${cards.length} 条`)
const clipped = cards.filter((c) => c.clipped)
check('存在被裁的摘要', clipped.length > 0, `${clipped.length} 条被裁`)
check(
  '被裁的都给了「展开全文」',
  clipped.every((c) => c.hasBtn && c.btnText === '展开全文'),
  JSON.stringify(clipped.map((c) => [c.id, c.btnText])),
)
check(
  '没被裁的不显示按钮',
  cards.filter((c) => !c.clipped).every((c) => !c.hasBtn),
)

// ================= B. 展开 / 收起 =================
const target = clipped[0]
if (target) {
  console.log('\n[B] 展开与收起')
  const card = page.locator(`[data-panel="left"] [data-chapter-id="${target.id}"]`)
  const before = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0)

  await card.getByRole('button', { name: '展开全文' }).click()
  await page.waitForTimeout(400)

  const expanded = await page.evaluate((id) => {
    const c = document.querySelector(`[data-panel="left"] [data-chapter-id="${id}"]`)
    const p = c?.querySelector('p')
    return {
      clipped: p ? p.scrollHeight > p.clientHeight + 1 : true,
      height: p ? Math.round(p.getBoundingClientRect().height) : 0,
      hasCollapse: [...(c?.querySelectorAll('button') || [])].some(
        (b) => (b.textContent || '').trim() === '收起',
      ),
      t: document.querySelector('video')?.currentTime ?? 0,
      playing: !(document.querySelector('video')?.paused ?? true),
    }
  }, target.id)
  check('展开后摘要不再被裁', !expanded.clipped, `高度 ${expanded.height}px`)
  check('出现「收起」按钮', expanded.hasCollapse)
  check(
    '展开不会顺带跳播',
    Math.abs(expanded.t - before) < 1.5 && !expanded.playing,
    `${before.toFixed(1)}s -> ${expanded.t.toFixed(1)}s，playing=${expanded.playing}`,
  )

  // exact 必须给：卡里还有「收起章节」「收起子节点」两个按钮，
  // 模糊匹配会把它们一起选出来（strict mode 直接报错）
  await card.getByRole('button', { name: '收起', exact: true }).click()
  await page.waitForTimeout(400)
  const collapsed = await page.evaluate((id) => {
    const c = document.querySelector(`[data-panel="left"] [data-chapter-id="${id}"]`)
    const p = c?.querySelector('p')
    return {
      clipped: p ? p.scrollHeight > p.clientHeight + 1 : false,
      height: p ? Math.round(p.getBoundingClientRect().height) : 0,
      backToExpand: [...(c?.querySelectorAll('button') || [])].some(
        (b) => (b.textContent || '').trim() === '展开全文',
      ),
    }
  }, target.id)
  check('收起后重新变成两行', collapsed.clipped && collapsed.height < expanded.height, `高度 ${collapsed.height}px`)
  check('按钮回到「展开全文」', collapsed.backToExpand)
}

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await page.locator('[data-panel="left"]').screenshot({
  path: 'J:/AIProject/RealVideoWebSite/.probe/chapter-summary-expand.png',
})
await page.close()
console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
