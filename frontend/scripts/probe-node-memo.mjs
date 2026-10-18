/**
 * 节点笔记（Markdown）的交互冒烟（2026-10-18）。
 *
 * 需求：给导图节点加笔记；右侧导图区里有一块笔记面板；有笔记的节点要有个图标
 * 和没笔记的区分；Markdown 要能读写两种模式（用开源 react-markdown 渲染）。
 *
 * 覆盖：
 *   [A] 打开面板 / 默认进编辑态 / 自动保存 / 阅读态真的渲染出 Markdown
 *   [B] 有笔记的节点在画布和大纲上都带小图标；清空后图标消失
 *   [C] 切节点时面板跟着切；刷新后内容还在
 *   [D] 只读模式下不能编辑（「编辑」按钮禁用）
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-node-memo.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = '锹农炮虫'
const A = 'nd7'
const B = 'nd8'

const MD = [
  '# 空间打手门槛',
  '',
  '特攻 **145** 但威力一般。',
  '',
  '- 速度最好比盾菇慢',
  '- 放电 80 分散，不算合格 AOE',
  '',
  '| 技能 | 威力 |',
  '| --- | --- |',
  '| 虫鸣 | 90 |',
  '',
  '`float` 免疫地面。',
].join('\n')

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

const canvasClick = (nid) =>
  page.evaluate((id) => {
    const inner = document.querySelector(`.react-flow__node[data-id="${id}"] .group > div`)
    if (!inner) return false
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  }, nid)

/** 合成 click 不算 pointerdown，ReactFlow 迟到的 selection 回调会把它清掉，点到生效为止 */
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

const panelOpen = () => page.locator('[data-role="node-note"]').count()
const textarea = () => page.locator('[data-role="note-textarea"]')
const rendered = () => page.locator('[data-role="note-rendered"]')
const noteMark = (nid) =>
  page.locator(`.react-flow__node[data-id="${nid}"] [data-role="note-mark"]`).count()

/** 后端真值（判断「到底存没存」不能只看界面） */
const storedNote = (nid) =>
  page.evaluate(async (id) => {
    const res = await fetch('/videomind/api/videos/2')
    const d = await res.json()
    const find = (n, x) => (n.id === x ? n : (n.children || []).map((c) => find(c, x)).find(Boolean))
    return find(d.mindmap, id)?.note ?? ''
  }, nid)

async function reloadAndOpen() {
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (!(await openVideo(KEYWORD))) return false
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '导图', exact: true }).click()
  await page.waitForTimeout(700)
  return true
}

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForSelector('.react-flow__node', { timeout: 20000 })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(600)

// ================= A. 打开面板 + 写 Markdown =================
console.log('\n[A] 打开笔记面板、写 Markdown、自动保存、阅读态渲染')
await enterEditMode()
check(`能选中 ${A}`, await selectCanvasNode(A))

const toggle = page.locator('[data-role="toggle-note"]')
check('工具栏上有笔记开关', (await toggle.count()) > 0)
await toggle.first().click()
await page.waitForTimeout(500)
check('笔记面板打开了', (await panelOpen()) === 1)
check('没写过笔记的节点默认进入编辑态', (await textarea().count()) === 1)
check(`面板表头显示节点名`, (await page.locator('[data-role="node-note"]').innerText()).includes('常配地龙'))

await textarea().fill(MD)
await page.waitForTimeout(2000) // 等自动保存（1.2s 防抖 + 往返）
const savedInDb = await storedNote(A)
check('自动保存后后端真的存下了', savedInDb.includes('空间打手门槛'), savedInDb.slice(0, 30))
check('状态显示「已保存」', (await page.locator('[data-role="node-note"]').innerText()).includes('已保存'))

await page.locator('[data-role="note-read-mode"]').click()
await page.waitForTimeout(500)
check('切到阅读态', (await rendered().count()) === 1)
const html = await page.evaluate(() => document.querySelector('[data-role="note-rendered"]')?.innerHTML || '')
check('标题渲染成 h1', html.includes('<h1'), html.slice(0, 60))
check('列表渲染成 li', html.includes('<li'))
check('表格渲染成 table（GFM）', html.includes('<table'))
check('行内代码渲染成 code', html.includes('<code'))
check('粗体渲染成 strong', html.includes('<strong'))

// ================= B. 有笔记的节点带图标 =================
console.log('\n[B] 有笔记的节点带小图标，和没笔记的区分开')
check(`${A} 画布上出现了笔记图标`, (await noteMark(A)) === 1)
check(`${B}（没笔记）没有图标`, (await noteMark(B)) === 0)

await page.getByRole('button', { name: '大纲', exact: true }).click()
await page.waitForTimeout(500)
const outlineMark = await page.locator(`[data-node-id="${A}"] [data-role="note-mark"]`).count()
check('大纲里也有笔记图标', outlineMark === 1, String(outlineMark))
await page.getByRole('button', { name: '导图', exact: true }).click()
await page.waitForTimeout(500)

// ================= C. 切节点 / 刷新后仍在 =================
console.log('\n[C] 切换节点、刷新后内容不丢')
check(`能选中 ${B}`, await selectCanvasNode(B))
await page.waitForTimeout(400)
const bEmpty = (await textarea().count()) > 0 || (await rendered().count()) > 0
check('面板跟着切到新节点（无笔记 → 编辑态）', bEmpty)
check('新节点面板里是空的', (await textarea().inputValue().catch(() => '')) === '')

check(`切回 ${A}`, await selectCanvasNode(A))
await page.waitForTimeout(500)
const backText = await textarea().inputValue().catch(async () => {
  const t = await rendered().innerText().catch(() => '')
  return t
})
check('切回来还能看到原内容', backText.includes('空间打手门槛'), backText.slice(0, 30))

check('刷新并重新打开导图', await reloadAndOpen())
check('刷新后图标还在', (await noteMark(A)) === 1)
await selectCanvasNode(A)
await page.locator('[data-role="toggle-note"]').first().click()
await page.waitForTimeout(600)
const afterReload = await page.evaluate(
  () => document.querySelector('[data-role="note-rendered"]')?.innerText || '',
)
check('刷新后面板默认阅读态且内容完整', afterReload.includes('空间打手门槛'), afterReload.slice(0, 30))

// ================= D. 只读模式不能编辑 =================
console.log('\n[D] 只读模式下只能读')
await exitEditMode()
await page.waitForTimeout(400)
const editBtn = page.locator('[data-role="note-edit-mode"]')
check('「编辑」按钮在只读模式下被禁用', await editBtn.first().isDisabled())
check(
  '提示写明要先切编辑模式',
  ((await editBtn.first().getAttribute('title')) || '').includes('只读'),
  (await editBtn.first().getAttribute('title')) || '',
)

// ================= E. 整树保存不能把笔记覆盖掉 =================
// 后端保存导图是「整树替换」：本地这份树是写笔记之前的快照，
// 加节点时若原样发过去，刚写好的笔记就没了。commit() 里会把笔记合回去。
console.log('\n[E] 写了笔记之后再增删节点，笔记不能丢')
await enterEditMode()
await selectCanvasNode(A)
await page.waitForTimeout(300)
if ((await page.locator('[data-role="note-edit-mode"]').count()) > 0) {
  const disabled = await page.locator('[data-role="note-edit-mode"]').isDisabled()
  if (!disabled) {
    await page.locator('[data-role="note-edit-mode"]').click()
    await page.waitForTimeout(200)
  }
}
if ((await textarea().count()) > 0) {
  await textarea().fill('# 保存前先写点什么\n\n- 不能被整树保存冲掉')
  await page.waitForTimeout(1800)
}
const noteBeforeAdd = await storedNote(A)
check('笔记已落库', noteBeforeAdd.includes('不能被整树保存冲掉'), noteBeforeAdd.slice(0, 20))

const beforeIds = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')].map((el) => el.getAttribute('data-id')),
)
await page.getByRole('button', { name: '+子', exact: true }).first().click()
await page.waitForTimeout(1400)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
const afterIds = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')].map((el) => el.getAttribute('data-id')),
)
check('确实新增了子节点（走了一次整树保存）', afterIds.length === beforeIds.length + 1)
check('整树保存后笔记还在', (await storedNote(A)).includes('不能被整树保存冲掉'), (await storedNote(A)).slice(0, 20))

const fresh = afterIds.find((id) => !beforeIds.includes(id))
if (fresh) {
  await selectCanvasNode(fresh)
  await page.getByRole('button', { name: '删除', exact: true }).first().click()
  await page.waitForTimeout(1200)
}
check('删掉子节点后笔记仍在', (await storedNote(A)).includes('不能被整树保存冲掉'))

// ================= 收尾：清掉测试笔记 =================
await enterEditMode()
await selectCanvasNode(A)
await page.locator('[data-role="note-edit-mode"]').click()
await page.waitForTimeout(300)
await textarea().fill('')
await page.waitForTimeout(2000)
check('清空后图标消失', (await noteMark(A)) === 0)
check('清空后后端也清掉了', (await storedNote(A)) === '', await storedNote(A))

// 顺带把之前接口冒烟留下的 nd3 笔记也清掉
await page.evaluate(async () => {
  await fetch('/videomind/api/videos/2/mindmap/nodes/nd3/note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '' }),
  })
})
check('nd3 的临时笔记已清理', (await storedNote('nd3')) === '')

await page.locator('[data-role="note-close"]').first().click()
await page.waitForTimeout(300)
check('面板能收起', (await panelOpen()) === 0)

await exitEditMode()
check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
