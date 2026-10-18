/**
 * 两条新需求的交互冒烟（2026-10-18）：
 *
 *   A. 新增「笔记节点」——不挂时间轴的节点。
 *      需求原文：「增加一种新的节点，这个节点没有时间区域，它的父节点也不会
 *      因为增加了这种节点而改变它本身的时间区域。」
 *      验证：能加、显示为「笔记」、父节点范围不变、点它视频不动、
 *            刷新后还是笔记（kind 没在保存时被洗掉）、章节不受影响。
 *
 *   B. 鼠标拖拽改变节点大小（节点右下角手柄）。
 *      验证：拖大 → 宽高与字号一起变 → 刷新后保持 → 能拖回原尺寸。
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 跑前务必 `http_proxy= HTTP_PROXY= no_proxy='*'`，否则 playwright 连 9222
 * 会被本机代理挡成 502。
 *
 * 用法：node frontend/scripts/probe-node-note.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = '锹农炮虫'
const HOST = 'nd7' // 400–460s：落在第二个章节中间，改它不牵动章节边界
const PARENT = 'nd5' // nd7 的父节点：加笔记前后范围必须一模一样
const RESIZE = 'nd3' // 用来试缩放手柄的叶子

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
// 删除节点确认框
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

/**
 * 点画布节点。
 *
 * 不能用 Playwright 的 click：画布缩小后相邻节点的包围盒会压过来，
 * 「点中心」会被邻节点拦截。这里直接对内层热区触发 click——
 * React 的事件委托挂在容器上，冒泡照样走 onClick。
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

const nodeBox = (nid) =>
  page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }, nid)

/** 页面上所有笔记节点的 id */
const noteIds = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')]
      .filter((el) => el.querySelector('[data-note="1"]'))
      .map((el) => el.getAttribute('data-id')),
  )


/**
 * 选中画布节点，直到顶部工具条的作用对象变成它。
 *
 * 为什么要重试：我们对节点内层派发的是**合成 click**，不走 pointerdown，
 * ReactFlow 内部的选中状态不会跟着变；它稍后抛出的 onSelectionChange（旧的
 * 那一次）会把容器里的 selectedId 清成 null，表现为「点了一下，工具条反而没了」。
 * 再点一次就正常了。这是测试手法带来的假象，不是产品缺陷（真鼠标点击没这问题）。
 */
async function selectCanvasNode(nid) {
  const want = await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] .group > div span.flex-1`)
    return (el?.textContent || '').trim()
  }, nid)
  for (let i = 0; i < 4; i += 1) {
    await canvasClick(nid)
    await page.waitForTimeout(350)
    const name = await page.evaluate(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '时间')
      return t?.parentElement?.querySelector('span.flex.items-center span:last-child')?.textContent || ''
    })
    if (want && name === want) return true
  }
  return false
}

const videoState = () =>
  page.evaluate(() => ({
    t: document.querySelector('video')?.currentTime ?? 0,
    playing: !(document.querySelector('video')?.paused ?? true),
  }))

/**
 * 刷新页面后重新把视频打开、切到导图。
 *
 * 刷新会把「当前选中哪支视频」一起清掉（它不在 URL 里），
 * 直接找「导图」按钮会等不到——必须先经过视频库重新点开。
 */
async function reloadAndOpenMap() {
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (!(await openVideo(KEYWORD))) return false
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '导图', exact: true }).click()
  await page.waitForTimeout(900)
  return true
}

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(900)
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(600)

// ================= A. 笔记节点 =================
console.log('\n[A] 新增笔记节点：没有时间范围，也不改变父节点的范围')
const parentBadgeBefore = await canvasBadge(PARENT)
const hostBadgeBefore = await canvasBadge(HOST)
console.log(`  info 加之前：父 ${PARENT}=${parentBadgeBefore}｜宿主 ${HOST}=${hostBadgeBefore}`)

await enterEditMode()
check(`画布上能选中 ${HOST}`, await canvasClick(HOST))
await page.waitForTimeout(400)

// 笔记按钮是纯图标（右栏宽度不够再放一个带文字的按钮），靠 aria-label 找
const addNoteBtn = page.getByRole('button', { name: '新增笔记节点', exact: true })
check('操作条上有「新增笔记」按钮', (await addNoteBtn.count()) > 0)
await addNoteBtn.first().click()
await page.waitForTimeout(700)

// 新节点会自动进入改名状态，顺手命名并提交
const labelInput = page.locator('.react-flow__node input').first()
if ((await labelInput.count()) > 0) {
  await labelInput.fill('我的笔记：回看这一段')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
}

const notes = await noteIds()
console.log(`  info 画布上的笔记节点：${notes.join(',') || '（无）'}`)
check('画布上出现了笔记节点', notes.length === 1, notes.join(','))
const noteId = notes[0] ?? ''

if (noteId) {
  const noteBadge = await canvasBadge(noteId)
  check('笔记节点的时间徽章是「笔记」', noteBadge === '笔记', noteBadge)

  const parentBadgeAfter = await canvasBadge(PARENT)
  const hostBadgeAfter = await canvasBadge(HOST)
  console.log(`  info 加之后：父 ${PARENT}=${parentBadgeAfter}｜宿主 ${HOST}=${hostBadgeAfter}`)
  check(
    '父节点的时间范围没有因为多了笔记而改变',
    parentBadgeAfter === parentBadgeBefore,
    `${parentBadgeBefore} -> ${parentBadgeAfter}`,
  )
  check(
    '宿主节点自己的时间也保住了（它只是多了一个子节点）',
    hostBadgeAfter === hostBadgeBefore,
    `${hostBadgeBefore} -> ${hostBadgeAfter}`,
  )

  // 工具条「时间」对笔记永久禁用
  check('能选中笔记节点', await selectCanvasNode(noteId))
  const timeBtn = page.getByRole('button', { name: '时间', exact: true })
  check(
    '选中笔记时「时间」按钮被禁用',
    (await timeBtn.count()) > 0 && (await timeBtn.first().isDisabled()),
  )
  check(
    '按钮提示说明笔记没有时间范围',
    ((await timeBtn.first().getAttribute('title')) || '').includes('笔记'),
    (await timeBtn.first().getAttribute('title')) || '',
  )

  // 宿主节点虽然多了一个子节点，但它只有一个**笔记**子节点，
  // 所以时间仍然归自己管：徽章不能变成「—」，「时间」按钮也不能被锁死。
  // （这条很容易漏：按 hasChildren 判断的话，给一个没时间的叶子加条笔记，
  //   它就永远设不了时间了。）
  check('能重新选中宿主节点', await selectCanvasNode(HOST))
  const hostBadge2 = await canvasBadge(HOST)
  check('宿主节点的徽章仍显示自己的时间', hostBadge2 === hostBadgeBefore, hostBadge2)
  const hostTimeBtn = page.getByRole('button', { name: '时间', exact: true })
  check(
    '宿主节点的「时间」按钮仍可用（时间不是由笔记算出来的）',
    (await hostTimeBtn.count()) > 0 && !(await hostTimeBtn.first().isDisabled()),
  )

  // 大纲视图里也显示「笔记」，而且没有时间可点
  await page.getByRole('button', { name: '大纲', exact: true }).click()
  await page.waitForTimeout(500)
  const outlineBadge = await page.evaluate((nid) => {
    const row = document.querySelector(`[data-node-id="${nid}"] [data-role="time-badge"]`)
    return row ? (row.textContent || '').replace(/\s+/g, '') : ''
  }, noteId)
  check('大纲里笔记也显示「笔记」', outlineBadge === '笔记', outlineBadge)
  await page.getByRole('button', { name: '导图', exact: true }).click()
  await page.waitForTimeout(500)

  // 只读模式点它：视频不动
  await exitEditMode()
  await page.evaluate(() => document.querySelector('video')?.pause())
  await page.waitForTimeout(300)
  const t0 = await videoState()
  await canvasClick(noteId)
  await page.waitForTimeout(700)
  const t1 = await videoState()
  check(
    '点笔记节点时视频不动',
    Math.abs(t1.t - t0.t) < 1 && !t1.playing,
    `${t0.t.toFixed(1)}s -> ${t1.t.toFixed(1)}s playing=${t1.playing}`,
  )

  // 刷新后还在（kind 必须活过 clean_mindmap_tree 的节点重建）
  check('刷新并重新打开导图', await reloadAndOpenMap())
  const notesAfterReload = await noteIds()
  check('刷新后笔记节点还在', notesAfterReload.length === 1, notesAfterReload.join(','))
  if (notesAfterReload.length === 1) {
    const b = await canvasBadge(notesAfterReload[0])
    check('刷新后仍然显示为「笔记」', b === '笔记', b)
  }
}

// ================= B. 拖拽改变节点大小 =================
console.log('\n[B] 鼠标拖右下角手柄改变节点大小')
await enterEditMode()
await canvasClick(RESIZE)
await page.waitForTimeout(400)
const boxBefore = await nodeBox(RESIZE)
console.log(`  info ${RESIZE} 尺寸：${boxBefore.w}×${boxBefore.h}`)

const handle = page.locator(`.react-flow__node[data-id="${RESIZE}"] [data-role="resize-handle"]`)
check('节点上有缩放手柄', (await handle.count()) > 0)

if ((await handle.count()) > 0) {
  await page.locator(`.react-flow__node[data-id="${RESIZE}"]`).hover()
  await page.waitForTimeout(150)
  const hb = await handle.boundingBox()
  const cx = hb.x + hb.width / 2
  const cy = hb.y + hb.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  // 分几步移动：一步跳过去的话，中间不会触发 pointermove 的增量计算
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(cx + (48 * i) / 6, cy, { steps: 2 })
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
  await page.waitForTimeout(1100)

  const boxAfter = await nodeBox(RESIZE)
  const nowScale = await handle.getAttribute('aria-valuenow')
  console.log(`  info 拖后尺寸：${boxAfter.w}×${boxAfter.h}｜scale=${nowScale}`)
  check('节点变宽了', boxAfter.w > boxBefore.w + 10, `${boxBefore.w} -> ${boxAfter.w}`)
  check('节点变高了', boxAfter.h > boxBefore.h, `${boxBefore.h} -> ${boxAfter.h}`)
  check('缩放系数被记下来了', Number(nowScale) > 1.05, String(nowScale))

  // 刷新后保持（说明真的落库了，不只是本地 state）
  check('刷新并重新打开导图', await reloadAndOpenMap())
  const boxReload = await nodeBox(RESIZE)
  check('刷新后大小保持', boxReload.w > boxBefore.w + 10, `${boxReload.w} vs ${boxBefore.w}`)

  // 还原到 100%：屏幕位移 = (1 / 当前 - 1) × 当前屏幕宽度
  await enterEditMode()
  await canvasClick(RESIZE)
  await page.waitForTimeout(300)
  const h2 = page.locator(`.react-flow__node[data-id="${RESIZE}"] [data-role="resize-handle"]`)
  const cur = Number(await h2.getAttribute('aria-valuenow')) || 1
  const box2 = await nodeBox(RESIZE)
  const dx = (1 / cur - 1) * box2.w
  await page.locator(`.react-flow__node[data-id="${RESIZE}"]`).hover()
  await page.waitForTimeout(150)
  const hb2 = await h2.boundingBox()
  const cx2 = hb2.x + hb2.width / 2
  const cy2 = hb2.y + hb2.height / 2
  await page.mouse.move(cx2, cy2)
  await page.mouse.down()
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(cx2 + (dx * i) / 6, cy2, { steps: 2 })
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
  await page.waitForTimeout(1100)
  const back = await h2.getAttribute('aria-valuenow')
  console.log(`  info 还原后 scale=${back}`)
  check('能把大小拖回 100%', Math.abs(Number(back) - 1) < 0.06, String(back))
}

// ================= 收尾：删掉测试笔记（顺带把历史遗留的也清掉）=================
await enterEditMode()
for (let i = 0; i < 5; i += 1) {
  const left = await noteIds()
  if (!left.length) break
  await canvasClick(left[0])
  await page.waitForTimeout(350)
  await page.getByRole('button', { name: '删除', exact: true }).first().click()
  await page.waitForTimeout(1000)
}
const after = await noteIds()
check('测试笔记已清理', after.length === 0, after.join(','))

await exitEditMode()
check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
