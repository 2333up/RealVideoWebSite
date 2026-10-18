/**
 * 节点时间范围编辑 + 章节跟随 的交互冒烟。
 *
 * 覆盖两条需求（2026-10-17）：
 *   1. 在导图节点 / 大纲里改时间戳，视频下方的章节要跟着变
 *      ——粒度是「章节边界跟着它包含的导图节点走」：改最靠前的节点动起点，
 *        改最靠后的节点动终点，只改中间的不动；不新建也不删除章节。
 *   2. 节点与大纲里要能设置**结束**时间，不只是开始
 *      ——分类节点（有子节点的分支）也要能设自己的时间范围。
 *
 * 脚本结束时会把改动还原，不留脏数据给后面的用例。
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-time-sync.mjs
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
await page.setViewportSize({ width: 1500, height: 950 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

/**
 * 切左栏的 tab。
 *
 * 章节和视频库现在共用左栏（章节从视频下方搬过去了），默认停在「视频库」，
 * 不切过去就一条章节都看不到——读章节前必须先切。
 */
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

/** 第一条章节卡上的时间文本（徽章 + 标题）
 *
 * 2026-10-18 起章节卡里还铺着节点树，整卡文本会跟着节点时间一起变，
 * 所以只读「章节徽章 + 章节标题」这两处——那才是章节本身的边界。
 */
const chapterText = async () => {
  await showTab('章节')
  return page.evaluate(() => {
    const card = document.querySelector('[data-panel="left"] [data-chapter-id]')
    if (!card) return ''
    const badge = card.querySelector('[data-role="chapter-badge"]')
    const title = card.querySelector('[data-role="chapter-title"]')
    return `${(badge?.textContent || '').trim()} ${(title?.textContent || '').trim()}`.trim()
  })
}

/** 某行节点的时间徽章文本（去掉空白，方便直接比对 00:40–01:50） */
const badgeOf = (nodeId) =>
  page.evaluate((nid) => {
    const el = document.querySelector(`[data-node-id="${nid}"] [data-role="time-badge"]`)
    return el ? (el.textContent || '').replace(/\s+/g, '') : ''
  }, nodeId)

/** 进编辑模式：点「只读」后按钮变成「编辑中」 */
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

/** 打开某个节点的时间编辑器，填入起止后保存 */
async function editRange(nodeId, startText, endText) {
  const badge = page
    .locator(`[data-node-id="${nodeId}"] [data-role="time-badge"]`)
    .first()
  if ((await badge.count()) === 0) return { ok: false, why: '找不到时间徽章' }
  await badge.click()
  await page.waitForTimeout(300)

  const sInput = page.locator('input[aria-label="时间范围起点"]')
  const eInput = page.locator('input[aria-label="时间范围终点"]')
  if ((await eInput.count()) === 0) return { ok: false, why: '没有终点输入框' }
  await sInput.fill(startText)
  await eInput.fill(endText)
  await page.getByRole('button', { name: '保存', exact: true }).first().click()

  // 等保存往返完成：「保存中…」消失 + 编辑器关闭
  await page
    .waitForFunction(() => !document.querySelector('input[aria-label="时间范围起点"]'), null, {
      timeout: 15000,
    })
    .catch(() => {})
  await page.waitForTimeout(600)
  return { ok: true }
}

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('打开 video-mind', (await page.locator('text=video-mind').count()) > 0)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(900)

await enterEditMode()

// ================= A. 大纲：改最靠前的节点 -> 章节起点跟着走 =================
console.log('\n[A] 大纲里改节点起点，章节跟着变')
await page.getByRole('button', { name: '大纲', exact: true }).click()
await page.waitForTimeout(500)

const before = await chapterText()
console.log(`  info 改前第一条章节：${before}`)
check('第一条章节起点为 00:00', before.includes('00:00'))

const r1 = await editRange('nd2', '40', '1:50')
check('nd2 能打开时间编辑器且带终点输入框', r1.ok, r1.why || '')
if (r1.ok) {
  const after = await chapterText()
  console.log(`  info 改后第一条章节：${after}`)
  check('章节起点跟着最靠前的节点变成 00:40', after.includes('00:40'), after)

  // 父节点（nd1 是分支）的范围必须跟着子节点走：起点取最早的那个
  const parentBadge = await badgeOf('nd1')
  console.log(`  info 父节点 nd1 徽章：${parentBadge}`)
  check(
    '父节点起点跟着最早子节点变成 00:40',
    parentBadge.startsWith('00:40'),
    parentBadge,
  )

  // ================= B. 只改中间节点，章节不动 =================
  console.log('\n[B] 只改中间节点，章节不动')
  const mid = await chapterText()
  const r2 = await editRange('nd3', '2:00', '3:20')
  check('nd3 时间可改', r2.ok, r2.why || '')
  const midAfter = await chapterText()
  check('章节没有被中间节点带动', midAfter === mid, `${mid} -> ${midAfter}`)

  // 还原 nd2 / nd3。注意：nd2 起点改回 9 之后，同步逻辑会把章节起点
  // 也带回 00:09——分析产出的原值是 00:00（开头 9 秒是寒暄，不属于任何要点）。
  // 章节归用户管，这里用章节编辑把它拨回去，别给后面的用例留脏数据。
  await editRange('nd2', '9', '1:50')
  await editRange('nd3', '110', '3:20')
  const restored = await chapterText()
  console.log(`  info 还原节点后第一条章节：${restored}`)

  if (!restored.includes('00:00')) {
    await page.locator('[data-panel="left"] [data-chapter-id]').first().hover()
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.locator('input[placeholder="起点 1:23 或 83"]').fill('0')
    await page.getByRole('button', { name: '保存', exact: true }).first().click()
    await page.waitForTimeout(900)
  }
  const finalText = await chapterText()
  console.log(`  info 收尾后第一条章节：${finalText}`)
  check('用例结束后章节还原到 00:00', finalText.includes('00:00'), finalText)
}

// ================= C. 画布：父节点时间不可编辑，且等于子节点并集 =================
console.log('\n[C] 分类节点的时间由子节点决定（不可手填）')
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(600)

const node = page.locator('.react-flow__node[data-id="nd1"]').first()
await node.click({ position: { x: 10, y: 10 } })
await page.waitForTimeout(400)

// 1. 工具条上的「时间」对分支禁用（叶子才可改）
const timeBtn = page.getByRole('button', { name: '时间', exact: true })
check('分类节点选中后「时间」按钮存在', (await timeBtn.count()) > 0)
check('分类节点的「时间」按钮被禁用', await timeBtn.first().isDisabled())
check(
  '按钮提示说明范围由子节点决定',
  ((await timeBtn.first().getAttribute('title')) || '').includes('子节点'),
  (await timeBtn.first().getAttribute('title')) || '',
)

// 2. 徽章显示的是算出来的范围，而不是「设时间」
const branchBadge = await page
  .locator('.react-flow__node[data-id="nd1"] [data-role="time-badge"]')
  .first()
  .innerText()
  .catch(() => '')
check('分类节点徽章显示「起–止」而不是「设时间」', /\d{2}:\d{2}\s*–\s*\d{2}:\d{2}/.test(branchBadge), branchBadge)

// 3. 徽章与「第一个子节点起点 → 最后一个子节点终点」一致（直接问后端要树来算）
const expectRange = await page.evaluate(async () => {
  const res = await fetch('/videomind/api/videos/2')
  const data = await res.json()
  const find = (n, id) => (n.id === id ? n : (n.children || []).map((c) => find(c, id)).find(Boolean))
  const fmt = (s) => {
    const t = Math.max(0, Math.floor(s))
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const sec = t % 60
    const p = (n) => String(n).padStart(2, '0')
    return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
  }
  const branch = find(data.mindmap, 'nd1')
  if (!branch || !branch.children?.length) return ''
  const first = branch.children[0]
  const last = branch.children[branch.children.length - 1]
  return `${fmt(first.start)}–${fmt(last.end)}`
})
console.log(`  info 期望范围（子节点并集）：${expectRange}｜实际徽章：${branchBadge}`)
check(
  '徽章 = 第一个子节点起点–最后一个子节点终点',
  !!expectRange && branchBadge.replace(/\s+/g, '') === expectRange,
)

// 4. 点徽章不会打开编辑器（而是跳到这里）
await page
  .locator('.react-flow__node[data-id="nd1"] [data-role="time-badge"]')
  .first()
  .click()
await page.waitForTimeout(500)
check(
  '点分类节点的时间徽章不会打开编辑框',
  (await page.locator('input[aria-label="时间范围起点"]').count()) === 0,
)

// 5. 右键菜单里的那一项也要改成「由子节点决定」且不可点
await node.click({ button: 'right', position: { x: 10, y: 10 } })
await page.waitForTimeout(400)
const menuItem = page.getByRole('button', { name: /时间范围由子节点决定/ })
check('右键菜单写明「时间范围由子节点决定」', (await menuItem.count()) > 0)
if ((await menuItem.count()) > 0) {
  check('右键菜单里该项不可点', await menuItem.first().isDisabled())
}
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// ================= D. 取消时间区域 =================
// 用户要求：节点的时间区域要能在编辑里「增加或取消」；**取消之后点它，
// 章节和视频都不该有任何反应**（不该退回跳到第一个子节点那种兜底）。
console.log('\n[D] 取消节点的时间区域')
await page.getByRole('button', { name: '大纲', exact: true }).click()
await page.waitForTimeout(500)
{
  const beforeBadge = await badgeOf('nd3')
  await page.locator('[data-node-id="nd3"] [data-role="time-badge"]').first().click()
  await page.waitForTimeout(300)
  const clearBtn = page.getByRole('button', { name: '清除时间', exact: true })
  check('时间编辑器里有「清除时间」入口', (await clearBtn.count()) > 0)
  if ((await clearBtn.count()) > 0) {
    await clearBtn.first().click()
    await page
      .waitForFunction(() => !document.querySelector('input[aria-label="时间范围起点"]'), null, {
        timeout: 15000,
      })
      .catch(() => {})
    await page.waitForTimeout(700)
    const afterBadge = await badgeOf('nd3')
    console.log(`  info nd3 徽章：${beforeBadge} → ${afterBadge}`)
    check('清除后徽章回到「设时间」', afterBadge.includes('设时间'), afterBadge)

    // 只读模式下点它：视频时间不能动。
    // 先暂停——前面几步把视频播起来了，不停的话时间本来就会自己往前走，
    // 那样量出来的是「播放进度」不是「有没有跳转」。
    await exitEditMode()
    await page.evaluate(() => document.querySelector('video')?.pause())
    await page.waitForTimeout(300)
    const t0 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0)
    await page.locator('[data-node-id="nd3"]').click()
    await page.waitForTimeout(700)
    const t1 = await page.evaluate(() => ({
      t: document.querySelector('video')?.currentTime ?? 0,
      playing: !(document.querySelector('video')?.paused ?? true),
    }))
    check(
      '没有时间区域的节点被点击时视频不动',
      Math.abs(t1.t - t0) < 1 && !t1.playing,
      `${t0.toFixed(1)}s → ${t1.t.toFixed(1)}s playing=${t1.playing}`,
    )

    // 恢复：把时间加回去
    await enterEditMode()
    await page.locator('[data-node-id="nd3"] [data-role="time-badge"]').first().click()
    await page.waitForTimeout(300)
    await page.locator('input[aria-label="时间范围起点"]').fill('1:50')
    await page.locator('input[aria-label="时间范围终点"]').fill('3:20')
    await page.getByRole('button', { name: '保存', exact: true }).first().click()
    await page
      .waitForFunction(() => !document.querySelector('input[aria-label="时间范围起点"]'), null, {
        timeout: 15000,
      })
      .catch(() => {})
    await page.waitForTimeout(700)
    const restoredBadge = await badgeOf('nd3')
    check('时间能再加回来', restoredBadge.length > 0 && !restoredBadge.includes('设时间'), restoredBadge)
  }
}

await exitEditMode()

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
