/**
 * 侧栏分割线 / 左栏折叠 / 章节 tab / 失败红框 的交互冒烟。
 *
 * 章节搬去左栏之后（2026-10-18），中栏只剩播放器，原来夹在播放器与章节之间的
 * 横向分割线也就不存在了——这个脚本跟着改成测竖向的侧栏分割线。
 *
 * 覆盖：
 *   1. 竖向分割线存在，拖动能改左栏宽度，中栏播放器跟着变窄
 *   2. 双击分割线折叠左栏，留下竖条，再点回来
 *   3. 布局落 localStorage：刷新后宽度还在
 *   4. 章节在左栏「章节」tab 里（中栏里不再有），删除入口收进编辑面板
 *   5. 处理失败的红框可收起（×），收起后还能「详情」再展开
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-splitter.mjs
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
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

/**
 * 切左栏的 tab。
 *
 * 章节现在和视频库共用左栏，默认停在「视频库」，
 * 不切过去就一条章节都看不到——脚本里凡是碰章节的用例都得先切。
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

/**
 * 按标题关键字点开左栏里的视频。
 * 分类树默认只展开「未分类」，目标可能藏在多级折叠的分类里，
 * 所以分多轮：每轮只点仍处于折叠态（data-expanded="false"）的分类行，
 * 展开后深一层才会出现，再下一轮继续——直到找到目标视频或轮次用尽。
 */
async function openVideo(keyword) {
  await showTab('视频库')
  for (let pass = 0; pass < 6; pass += 1) {
    // 折叠态看 data-expanded，不看行里有没有「▸」字符——
    // 三角已经换成 SVG，文本里不再有这个字
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

// 清空历史布局，保证从默认状态开始量
await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.removeItem('video-mind:layout.v1'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)

// ================= A. 竖向分割线（左栏宽度） =================
console.log('\n[A] 左栏与中栏之间的竖向分割线')
const opened = await openVideo('锹农炮虫')
check('点开带章节的视频', opened)
if (opened) {
  await page.waitForTimeout(1500)
  const sep = page.locator('div[role="separator"][aria-orientation="vertical"]')
  check('竖向分割线两条（左栏 + 右栏）', (await sep.count()) === 2, `找到 ${await sep.count()} 条`)
  const leftSep = page.locator('div[role="separator"][aria-label="调整左侧栏宽度"]')
  check('左栏分割线存在', (await leftSep.count()) === 1)

  const box = await leftSep.first().boundingBox()
  check('分割线可定位', !!box, box ? `x=${Math.round(box.x)}` : '无 boundingBox')

  const metrics = async () =>
    page.evaluate(() => {
      const aside = document.querySelector('[data-panel="left"]')
      const stage = document.querySelector('[data-player-stage]')
      return {
        left: Math.round(aside.getBoundingClientRect().width),
        stageW: stage ? Math.round(stage.getBoundingClientRect().width) : -1,
      }
    })
  const before = await metrics()

  // 往右拖：左栏变宽，中栏变窄，播放器画面跟着变小
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 40, cy, { steps: 6 })
  await page.mouse.move(cx + 90, cy, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const after = await metrics()
  check(
    '往右拖左栏变宽',
    after.left > before.left + 60,
    `${before.left}px → ${after.left}px`,
  )
  check(
    '中栏变窄后播放器画面跟着变小',
    after.stageW < before.stageW - 30,
    `窗口 ${before.stageW}px → ${after.stageW}px`,
  )

  // 往左拖回去：这次画面变大
  const box2 = await leftSep.first().boundingBox()
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
  await page.mouse.down()
  await page.mouse.move(box2.x + box2.width / 2 - 60, box2.y + box2.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const back = await metrics()
  check(
    '往左拖能还原（画面变大）',
    back.left < after.left - 40 && back.stageW > after.stageW + 20,
    `左栏 ${after.left}px → ${back.left}px，窗口 ${after.stageW}px → ${back.stageW}px`,
  )

  // ================= B. 双击折叠 / 展开 =================
  console.log('\n[B] 双击折叠与展开左栏')
  await leftSep.first().dblclick()
  await page.waitForTimeout(400)
  const railBtn = page.locator('button[aria-label^="展开"]')
  check('双击分割线折叠左栏', (await railBtn.count()) > 0)
  const asideCount = await page.locator('[data-panel="left"]').count()
  check('折叠后左栏收成窄条', asideCount === 0, `aside 还在 ${asideCount} 个`)
  await railBtn.first().click()
  await page.waitForTimeout(500)
  check('点窄栏能展开回来', (await leftSep.count()) === 1)

  // ================= C. 布局持久化 =================
  console.log('\n[C] 布局持久化')
  const saved = await page.evaluate(() => localStorage.getItem('video-mind:layout.v1'))
  check('布局写入 localStorage', !!saved && saved.includes('leftWidth'), (saved || '').slice(0, 90))
  check('存档里不再有作废的播放器高度', !!saved && !saved.includes('playerHeight'))
  // 刷新会清掉选中态，所以先重新点开同一个视频再量宽度
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await openVideo('锹农炮虫')
  await page.waitForTimeout(1200)
  const restored = await metrics()
  check(
    '刷新后左栏宽度保持',
    Math.abs(restored.left - back.left) < 4,
    `${back.left}px → ${restored.left}px`,
  )
}

// ================= C2. 章节在左栏 tab 里 =================
console.log('\n[C2] 章节搬到左栏 tab')
await showTab('章节')
const inAside = await page.evaluate(
  () => document.querySelectorAll('[data-panel="left"] [data-chapter-id]').length,
)
const inMain = await page.evaluate(() => document.querySelectorAll('main [data-chapter-id]').length)
check('章节出现在左栏', inAside > 0, `${inAside} 条`)
check('中栏里没有章节卡', inMain === 0, `${inMain} 条`)
check(
  '中栏只剩播放器',
  (await page.evaluate(() => document.querySelectorAll('main [data-player-stage]').length)) === 1,
)

// ================= C3. 章节删除入口收进编辑面板 =================
console.log('\n[C3] 章节的删除入口')
{
  const row = page.locator('[data-chapter-id]').first()
  await row.hover()
  await page.waitForTimeout(200)
  const editBtn = page.getByRole('button', { name: '编辑', exact: true })
  check('列表上保留「编辑」入口', (await editBtn.count()) > 0)
  // 只在章节列表范围内找：右栏导图工具条上也有一个「删除」（删节点），别被它带偏
  check(
    '列表上不再有独立的「删除」按钮',
    (await page
      .locator('[data-chapter-id]')
      .getByRole('button', { name: '删除', exact: true })
      .count()) === 0,
  )
  await editBtn.first().click()
  await page.waitForTimeout(300)
  check(
    '删除按钮出现在编辑面板里',
    (await page.getByRole('button', { name: /删除本章节/ }).count()) > 0,
  )
  // 只验证入口在，不真删——留着章节给后面的用例
  await page.getByRole('button', { name: '取消', exact: true }).first().click()
  await page.waitForTimeout(300)
  check('取消后回到展示态', (await page.locator('[data-chapter-id]').count()) > 0)
}

// ================= D. 失败红框可收起 =================
console.log('\n[D] 失败红框可收起')
const opened2 = await openVideo('18-18-20')
check('点开处理失败的视频', opened2)
if (opened2) {
  await page.waitForTimeout(1500)
  const failBox = page.locator('text=处理失败').first()
  check('失败提示出现', (await failBox.count()) > 0)
  // 只认错误原文那段 <p>：同色的「重试」按钮也带 text-red-700，会误判
  const errText = page.locator('main p.text-red-700')
  const hasErr = (await errText.count()) > 0
  check('错误原文默认展开', hasErr)
  if (hasErr) {
    const stageH = () =>
      page.evaluate(() =>
        Math.round(document.querySelector('[data-player-stage]')?.getBoundingClientRect().height ?? 0),
      )
    const h0 = (await errText.first().boundingBox())?.height ?? 0
    const s0 = await stageH()
    await page.locator('button[aria-label="收起错误详情"]').first().click()
    await page.waitForTimeout(400)
    const stillThere = await errText.count()
    check('点 × 收起错误原文', stillThere === 0, `折叠前高度 ${Math.round(h0)}px`)
    const detailBtn = page.getByRole('button', { name: '详情' })
    check('收起后出现「详情」入口', (await detailBtn.count()) > 0)
    // 红框收起后腾出来的高度应当还给了播放区（至少不比收起前更矮）
    const s1 = await stageH()
    check('红框收起后播放区没被挤小', s1 >= s0, `窗口 ${s0}px → ${s1}px`)
    await detailBtn.first().click().catch(() => {})
    await page.waitForTimeout(250)
    check('点「详情」可再展开', (await errText.count()) > 0)
  }
}

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
