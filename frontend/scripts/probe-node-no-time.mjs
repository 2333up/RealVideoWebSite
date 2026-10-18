/**
 * 画布侧验证：在编辑里「清除时间」后，只读模式点这个节点，视频纹丝不动。
 *
 * 前置：CDP 9222 + 前端 5173 + 后端 8000。
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = '锹农炮虫'
const NODE = 'nd7' // 400–460s，落在第二个章节中间，改它不牵动章节边界

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

async function showTab(name) {
  const panel = page.locator('[data-panel="left"]')
  if ((await panel.count()) === 0) return
  const btn = panel.getByRole('button', { name: new RegExp(`^${name}`) })
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

async function enterEditMode() {
  const ro = page.getByRole('button', { name: '只读', exact: true })
  if ((await ro.count()) > 0) {
    await ro.first().click()
    await page.waitForTimeout(300)
  }
}
async function exitEditMode() {
  const ed = page.getByRole('button', { name: '编辑中', exact: true })
  if ((await ed.count()) > 0) {
    await ed.first().click()
    await page.waitForTimeout(300)
  }
}

/**
 * 点画布节点。
 *
 * 不能用 Playwright 的 click：画布缩小后相邻节点的包围盒会压过来，
 * 「点中心」会被邻节点拦截（之前就是这么超时的）。这里直接对内层热区
 * 触发 click，React 的事件委托挂在容器上，冒泡照样走 onClick。
 */
const canvasClick = (nid) =>
  page.evaluate((id) => {
    const inner = document.querySelector(`.react-flow__node[data-id="${id}"] .group > div`)
    if (!inner) return false
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  }, nid)

const canvasBadge = (nid) =>
  page.evaluate((id) => {
    const el = document.querySelector(
      `.react-flow__node[data-id="${id}"] [data-role="time-badge"]`,
    )
    return el ? (el.textContent || '').replace(/\s+/g, '') : ''
  }, nid)

const videoState = () =>
  page.evaluate(() => ({
    t: document.querySelector('video')?.currentTime ?? 0,
    playing: !(document.querySelector('video')?.paused ?? true),
  }))

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(900)

// 停在导图（画布）
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(600)

const original = await canvasBadge(NODE)
console.log(`  info ${NODE} 原徽章：${original}`)
check('节点原本有时间范围', /\d{2}:\d{2}.*\d{2}:\d{2}/.test(original), original)

// ---- 1. 编辑模式里选中节点 → 工具条「时间」 → 清除时间 ----
await enterEditMode()
check('画布上能选中节点', await canvasClick(NODE))
await page.waitForTimeout(400)

const timeBtn = page.getByRole('button', { name: '时间', exact: true })
check('叶子节点选中后「时间」按钮可用', (await timeBtn.count()) > 0 && !(await timeBtn.first().isDisabled()))
await timeBtn.first().click()
await page.waitForTimeout(400)

const clearBtn = page.getByRole('button', { name: '清除时间', exact: true })
check('时间编辑器里有「清除时间」入口', (await clearBtn.count()) > 0)
await clearBtn.first().click()
await page
  .waitForFunction(() => !document.querySelector('input[aria-label="时间范围起点"]'), null, {
    timeout: 15000,
  })
  .catch(() => {})
await page.waitForTimeout(800)
const cleared = await canvasBadge(NODE)
console.log(`  info 清除后徽章：${cleared}`)
check('清除后画布徽章变回「设时间」', cleared.includes('设时间'), cleared)

// ---- 2. 只读模式下点它：视频不动、也不开始播 ----
await exitEditMode()
await page.evaluate(() => document.querySelector('video')?.pause())
await page.waitForTimeout(300)
const t0 = await videoState()
check('点击前视频是暂停的', !t0.playing, `${t0.t.toFixed(1)}s`)

await canvasClick(NODE)
await page.waitForTimeout(800)
const t1 = await videoState()
check(
  '没有时间范围的节点被点击时视频不动',
  Math.abs(t1.t - t0.t) < 1 && !t1.playing,
  `${t0.t.toFixed(1)}s → ${t1.t.toFixed(1)}s playing=${t1.playing}`,
)

// 对照：换一个还有时间的节点点一下，视频应该会跳过去（证明不是播放器整体失灵）
const t2before = await videoState()
await canvasClick('nd8')
await page.waitForTimeout(900)
const t2 = await videoState()
check(
  '对照组（有时间范围的节点）仍能跳转',
  Math.abs(t2.t - t2before.t) > 1 || t2.t > 455,
  `${t2before.t.toFixed(1)}s → ${t2.t.toFixed(1)}s`,
)

// ---- 3. 把时间加回去，别留脏数据 ----
await page.evaluate(() => document.querySelector('video')?.pause())
await enterEditMode()
await canvasClick(NODE)
await page.waitForTimeout(300)
await page.getByRole('button', { name: '时间', exact: true }).first().click()
await page.waitForTimeout(400)
await page.locator('input[aria-label="时间范围起点"]').fill('400')
await page.locator('input[aria-label="时间范围终点"]').fill('460')
await page.getByRole('button', { name: '保存', exact: true }).first().click()
await page
  .waitForFunction(() => !document.querySelector('input[aria-label="时间范围起点"]'), null, {
    timeout: 15000,
  })
  .catch(() => {})
await page.waitForTimeout(800)
const restored = await canvasBadge(NODE)
console.log(`  info 还原后徽章：${restored}`)
check('时间能再加回来', restored === original, `${restored} vs ${original}`)

await exitEditMode()
check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
