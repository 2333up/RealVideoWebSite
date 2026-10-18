/**
 * 画布视角稳定性（2026-10-18 用户反馈）。
 *
 * 需求原文：「当新增节点时，整个思维导图的页面会重置，我不希望这样。
 * 当增加节点时不会改变思维导图画布的形态。」
 *
 * 病根有两处，都在 MindMapCanvas：
 *   1. 重新铺满（fitView）的触发条件里带着 `layout.visibleCount` —— 节点数一变
 *      就整页 refit，用户刚调好的缩放被重置（实测 0.462 → 0.385）；
 *   2. 「把选中节点带到视野」用的是 `zoom: max(getZoom(), 0.75)` —— 键盘走一格
 *      画面就突然放大。
 *
 * 现在的约定：
 *   - 只有**换一种看法**才 refit：切视频 / 折叠 / 展开 / 聚焦 / 搜索；
 *   - 新增、删除、改名、改时间一律不动视角；
 *   - 键盘导航只在目标跑出视野时才平移，且**保持当前缩放**。
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-canvas-stable.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = '锹农炮虫'
const HOST = 'nd7'

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
page.on('dialog', (d) => d.accept())

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

/** 画布的平移+缩放。字符串直接比，任何抖动都藏不住 */
const viewport = () =>
  page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '')

const canvasClick = (nid) =>
  page.evaluate((id) => {
    const inner = document.querySelector(`.react-flow__node[data-id="${id}"] .group > div`)
    if (!inner) return false
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  }, nid)

/** 合成 click 有时会被 ReactFlow 迟到的 selection 回调清掉，点到生效为止 */
async function selectCanvasNode(nid) {
  const want = await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] .group > div span.flex-1`)
    return (el?.textContent || '').trim()
  }, nid)
  for (let i = 0; i < 4; i += 1) {
    await canvasClick(nid)
    await page.waitForTimeout(320)
    const name = await page.evaluate(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '时间')
      return t?.parentElement?.querySelector('span.flex.items-center span:last-child')?.textContent || ''
    })
    if (want && name === want) return true
  }
  return false
}

const canvasBadge = (nid) =>
  page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] [data-role="time-badge"]`)
    return el ? (el.textContent || '').replace(/\s+/g, '') : ''
  }, nid)

const childIds = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')]
      .map((el) => el.getAttribute('data-id'))
      .filter(Boolean),
  )

const scaleOf = (style) => Number((style.match(/scale\(([\d.]+)\)/) || [])[1] || 0)

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(700)

// ================= A. 新增 / 删除节点不改变画布形态 =================
console.log('\n[A] 增删节点时画布纹丝不动')
const v0 = await viewport()
console.log(`  info 初始视角：${v0}`)
check('拿到初始视角', v0.includes('scale'), v0)

await enterEditMode()
check(`能选中 ${HOST}`, await selectCanvasNode(HOST))
const before = await childIds()
const hostBadge0 = await canvasBadge(HOST)

await page.getByRole('button', { name: '+子', exact: true }).first().click()
await page.waitForTimeout(1200)
const v1 = await viewport()
// 加子节点绝不能把宿主自己的时间抹掉（旧逻辑会 pop 掉 start，
// 删掉子节点也回不来——这是实测踩到的数据丢失）
const hostBadge1 = await canvasBadge(HOST)
check('加子节点后宿主节点仍保有自己的时间', hostBadge1 === hostBadge0, `${hostBadge0} -> ${hostBadge1}`)
const afterAdd = await childIds()
console.log(`  info 加节点后：${v1}`)
check('确实新增了一个节点', afterAdd.length === before.length + 1, `${before.length} -> ${afterAdd.length}`)
check('新增节点后缩放没变', scaleOf(v1) === scaleOf(v0), `${scaleOf(v0)} -> ${scaleOf(v1)}`)
check('新增节点后画布没有平移', v1 === v0, v1)

// 退出改名状态，再删掉刚加的节点
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const fresh = afterAdd.find((id) => !before.includes(id))
if (fresh) {
  await selectCanvasNode(fresh)
  await page.getByRole('button', { name: '删除', exact: true }).first().click()
  await page.waitForTimeout(1200)
}
const v2 = await viewport()
check('删除节点后画布也没动', v2 === v0, v2)
const hostBadge2 = await canvasBadge(HOST)
check('删掉子节点后宿主时间还是原来的', hostBadge2 === hostBadge0, `${hostBadge0} -> ${hostBadge2}`)
check('节点数回到原样', (await childIds()).length === before.length)

// ================= B. 折叠 / 展开仍然重新铺满 =================
console.log('\n[B] 折叠、展开仍然会重新铺满（这是要保留的）')
await page.getByRole('button', { name: '全部收起，只剩根节点' }).first().click()
await page.waitForTimeout(900)
const vCollapsed = await viewport()
console.log(`  info 收起后：${vCollapsed}`)
check('收起后重新铺满了（视角变化）', vCollapsed !== v0, `${v0} -> ${vCollapsed}`)

await page.getByRole('button', { name: '展开所有分支' }).first().click()
await page.waitForTimeout(900)
const vExpanded = await viewport()
console.log(`  info 展开后：${vExpanded}`)
check('展开后又铺满了', vExpanded !== vCollapsed, vExpanded)

// ================= C. 键盘导航只平移、不改缩放 =================
console.log('\n[C] 键盘切换选中不改缩放')
await exitEditMode()
await selectCanvasNode(HOST)
const vk0 = await viewport()
await page.locator('.react-flow__pane').hover().catch(() => {})
for (let i = 0; i < 6; i += 1) {
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(180)
}
await page.waitForTimeout(500)
const vk1 = await viewport()
console.log(`  info 按 6 次 ↓：${vk0} -> ${vk1}`)
check('方向键没有改变缩放', scaleOf(vk1) === scaleOf(vk0), `${scaleOf(vk0)} -> ${scaleOf(vk1)}`)

// ================= D. 聚焦仍然重新铺满 =================
// 注意别用「搜索」来测：搜索不改变可见节点集合，fitView 算出来的变换和原来
// 一模一样，断言「视角变了」会误报。真正会换视角的是「只看这一支」。
console.log('\n[D] 聚焦某分支仍会重新铺满')
const vf0 = await viewport()
await page
  .locator(`.react-flow__node[data-id="${HOST}"] .group > div`)
  .click({ button: 'right', force: true })
  .catch(() => {})
await page.waitForTimeout(400)
const focusItem = page.getByRole('button', { name: '仅显示该分支' })
check('右键菜单里有「仅显示该分支」', (await focusItem.count()) > 0)
if ((await focusItem.count()) > 0) {
  await focusItem.first().click()
  await page.waitForTimeout(1000)
  const vf1 = await viewport()
  check('聚焦后画布重新铺满', vf1 !== vf0, `${vf0} -> ${vf1}`)
  await page.getByTitle('退出聚焦，显示全部').first().click()
  await page.waitForTimeout(900)
}

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
