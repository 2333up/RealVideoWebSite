/**
 * 用真实浏览器点击验证导图的鼠标交互。
 *
 * 为什么要这个脚本：这一版导图踩过一个「节点点击没反应」的坑——
 * 悬浮工具条用 opacity-0 隐藏，但它**依然接收鼠标事件**，正好压在
 * 下方兄弟节点的上边缘（节点间距 12px，工具条占 4~26px）。
 * 静态审查看不出来，只有真的把鼠标放在那个位置问「这个点上是谁」才能发现。
 *
 * 融合后适配（原版跑在独立的 smoke.html 上，那页没入库）：
 *  - 入口改为合并后的应用 http://127.0.0.1:5173/videomind/，
 *    脚本会自己在左侧列表里点开第一支「已完成」的视频；
 *  - 跳转日志原来由 smoke.html 的 mock 播放器写 window.__log.seek，
 *    现在改用 page.addInitScript 给 HTMLMediaElement.prototype.currentTime
 *    的 setter 打补丁，记录每一次赋值——等价于「播放器收到了跳转请求」，
 *    且不受 seeking 事件在重复时间点上可能不触发的影响。
 *
 * 前置条件：
 *  - 后端（:8000）与前端 dev server（:5173）都在跑；
 *  - 库里至少有一支已分析（有思维导图）的视频，且它的源文件还在原处——
 *    播放器要拿到 metadata 才会执行跳转。
 *
 * 用法：NODE_PATH=<workspace>/node_modules node frontend/scripts/probe-mindmap.mjs
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

/**
 * 浏览器可执行文件：环境变量 PROBE_CHROME 优先，
 * 否则用候选列表里第一个存在的。原脚本写死了作者机器上 playwright 下载的
 * chromium；Edge 同为 Chromium 内核，playwright-core 可以直接驱动，
 * 换机器时不必再下一遍浏览器。
 */
const CHROME_CANDIDATES = [
  process.env.PROBE_CHROME,
  'C:/Users/momo/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const EXECUTABLE = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!EXECUTABLE) {
  console.log(`找不到可用的 Chromium 内核浏览器，试过：\n${CHROME_CANDIDATES.join('\n')}`)
  process.exit(1)
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch({ executablePath: EXECUTABLE })
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })

// 跳转日志：记录每一次 currentTime 赋值。React 的状态更新是异步的，
// 赋值发生在点击之后的某个微任务里，所以读取前都要等它落定。
await page.addInitScript(() => {
  window.__log = { seek: [] }
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    ...desc,
    set(v) {
      window.__log.seek.push(v)
      desc.set.call(this, v)
    },
  })
})

/** 等跳转日志至少攒到 n 条（React 提交需要时间），超时返回当前条数 */
async function waitSeekCount(n, timeout = 2000) {
  const t0 = Date.now()
  for (;;) {
    const count = await page.evaluate(() => window.__log.seek.length)
    if (count >= n || Date.now() - t0 > timeout) return count
    await page.waitForTimeout(100)
  }
}

/**
 * 在左侧列表里点开一支视频，等导图渲染出来。
 * 刷新会丢掉 React 里的 selectedId，页面回到列表——所以每次 reload 之后
 * 都要靠这个函数把同一支视频重新打开（按标题认人）。
 */
/**
 * 展开全部分类。默认只展开「未分类」，视频可能整批藏在折叠的分类里，
 * 不先展开就只能在 rows[0]（「未分类」这一行本身）上兜底，等于没选中视频。
 */
async function expandFolders() {
  for (let pass = 0; pass < 6; pass += 1) {
    await page.evaluate(() => {
      for (const r of document.querySelectorAll('[data-panel="left"] [data-folder-row][data-expanded="false"]')) {
        r.click()
      }
    })
    await page.waitForTimeout(200)
  }
}

/**
 * 找一块真正的画布空白。
 * 必须在每次拖拽前**重新**找：中途平移过画布之后，
 * 上一次记下的坐标很可能已经压在某个节点上——那就变成拖节点而不是框选了。
 */
async function findEmpty() {
  const pane = await page.locator('.react-flow__pane').boundingBox()
  return page.evaluate(
    (r) => {
      for (const dx of [6, 20, 40, 60, 90]) {
        for (const dy of [6, 20, 40, 60, 90]) {
          const el = document.elementFromPoint(r.x + dx, r.y + dy)
          if (el && el.classList.contains('react-flow__pane')) return { x: r.x + dx, y: r.y + dy }
        }
      }
      return null
    },
    pane,
  )
}

/**
 * 把「左键拖画布的含义」切到目标模式。
 *
 * 工具条压成一行后这是个来回切换的单按钮，显示的是**当前**模式：
 * 想要平移就得在看到「框选」时点它。直接按名字找目标按钮会扑空。
 */
async function ensureTool(target) {
  // target=pan 时，界面上显示「框选」说明当前是框选，点它切过去；
  // 显示「平移」说明已经是平移，不用动
  const other = target === 'pan' ? '框选' : '平移'
  const btn = page.getByRole('button', { name: other, exact: true })
  if ((await btn.count()) > 0) {
    await btn.first().click()
    await page.waitForTimeout(200)
  }
}

async function openVideo(title) {
  await expandFolders()
  await page.evaluate((t) => {
    const rows = [...document.querySelectorAll('[data-panel="left"] div.cursor-pointer')]
    const row =
      rows.find((r) => (r.querySelector('.truncate')?.textContent ?? '').includes(t)) ??
      rows.find((r) => r.textContent.includes('已完成')) ??
      rows[0]
    row?.click()
  }, title)
  await page.waitForSelector('.react-flow__node', { timeout: 15000 })
  await page.waitForTimeout(600)
}

await page.goto('http://127.0.0.1:5173/videomind/', { waitUntil: 'networkidle' })

// 自己点开一支视频：合并后的应用没有按 URL 选视频的路由，
// 左侧列表第一行点下去才会加载详情、渲染导图。优先挑「已完成」的。
await expandFolders()
const opened = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-panel="left"] div.cursor-pointer')]
  const row = rows.find((r) => r.textContent.includes('已完成')) ?? rows[0]
  if (!row) return null
  const title = row.querySelector('.truncate')?.textContent ?? ''
  row.click()
  return title
})
if (!opened) {
  console.log('左侧视频列表是空的——先导入并分析一支视频再跑本脚本')
  await browser.close()
  process.exit(1)
}
console.log(`已打开视频：${opened}`)

await page.waitForSelector('.react-flow__node', { timeout: 15000 })
await page.waitForTimeout(600)

const nodeCount = await page.locator('.react-flow__node').count()
console.log(`渲染出 ${nodeCount} 个节点`)

// ---------------------------------------------------------------- 命中测试
// 在每个节点的 9 个采样点上问「这里最上层是谁」，若不是节点自己，
// 说明有东西挡住了点击（多半是上一个节点的悬浮工具条）。
const probes = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('.react-flow__node')) {
    const id = el.getAttribute('data-id')
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    const pts = [
      ['上中', r.left + r.width / 2, r.top + 3],
      ['中心', r.left + r.width / 2, r.top + r.height / 2],
      ['下中', r.left + r.width / 2, r.bottom - 3],
    ]
    for (const [label, x, y] of pts) {
      const top = document.elementFromPoint(x, y)
      const ownNode = top && top.closest('.react-flow__node')
      const cls = top
        ? typeof top.className === 'string'
          ? top.className
          : String(top.className?.baseVal ?? top.tagName)
        : 'none'
      out.push({
        id,
        label,
        owner: ownNode ? ownNode.getAttribute('data-id') : null,
        blocker: ownNode ? null : `<${top ? top.tagName : '?'} class="${cls}">`,
      })
    }
  }
  return out
})

const blocked = probes.filter((p) => p.owner !== p.id)
console.log(`\n命中测试：${probes.length} 个采样点`)
check(
  '每个节点自身都位于最上层（无元素遮挡点击）',
  blocked.length === 0,
  blocked.slice(0, 4).map((b) => `${b.id} 的${b.label}被 ${b.blocker} 压住`).join('; '),
)

// ---------------------------------------------------------------- 点击跳转
const target = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.react-flow__node')]
  // 找一个肯定带时间戳的节点：认准时间徽章的 data-role。
  // 早前用 button.tabular-nums 找，会误命中分类节点上的「折叠圆点」——
  // 那个按钮同样带 tabular-nums，文本是「−」，于是「带时间戳的节点」
  // 实际选中了一个分类节点，后面的断言全靠这个巧合成立。
  for (const el of nodes) {
    const badge = el.querySelector('button[data-role="time-badge"]')
    if (badge && !badge.textContent.includes('设时间')) {
      return { id: el.getAttribute('data-id'), text: badge.textContent }
    }
  }
  return null
})

/** 找一个「有子节点」的节点（靠折叠圆点认人）——折叠类操作只对它有意义 */
const parentNode = await page.evaluate(() => {
  for (const el of document.querySelectorAll('.react-flow__node')) {
    const dot = el.querySelector('button[title*="折叠该分支"]')
    if (dot) return { id: el.getAttribute('data-id') }
  }
  return null
})

if (!target) {
  check('找到带时间戳的节点', false)
} else {
  console.log(`\n跳转测试：点节点 ${target.id}（时间戳 ${target.text}）`)
  const box = await page.locator(`.react-flow__node[data-id="${target.id}"]`).boundingBox()
  // 故意点上边缘：正是被工具条压住的那块区域
  await page.mouse.click(box.x + box.width / 2, box.y + 3)
  await waitSeekCount(1)
  const seekTop = await page.evaluate(() => window.__log.seek.slice())
  check('点击节点上边缘能触发跳转', seekTop.length === 1, `seek=${JSON.stringify(seekTop)}`)

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await waitSeekCount(2)
  const seekMid = await page.evaluate(() => window.__log.seek.slice())
  check('点击节点中心能触发跳转', seekMid.length === 2, `seek=${JSON.stringify(seekMid)}`)
}

// ---------------------------------------------------------------- 编辑模式闸门
if (target) {
  const box = await page.locator(`.react-flow__node[data-id="${target.id}"]`).boundingBox()
  const inputsIn = (id) =>
    page.locator(`.react-flow__node[data-id="${id}"] input`).count()

  // 默认只读：双击不该弹出输入框
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  check('只读模式下双击不会进入改名', (await inputsIn(target.id)) === 0)

  // 切到编辑模式后双击才改名
  await page.getByRole('button', { name: '只读' }).click()
  await page.waitForTimeout(200)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  const editableInputs = await inputsIn(target.id)
  check('编辑模式下双击进入改名', editableInputs > 0)
  if (editableInputs > 0) await page.keyboard.press('Escape')

  // 编辑模式下点节点不应该触发播放跳转
  await page.evaluate(() => {
    window.__log.seek = []
  })
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  const seekInEdit = await page.evaluate(() => window.__log.seek.slice())
  check(
    '编辑模式下点击节点不跳转播放',
    seekInEdit.length === 0,
    `seek=${JSON.stringify(seekInEdit)}`,
  )

  // 回到只读，确认右键菜单里的写操作被锁住
  await page.getByRole('button', { name: '编辑中' }).click()
  await page.waitForTimeout(200)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.waitForTimeout(300)
  const renameDisabled = await page
    .locator('div.fixed.z-50 button', { hasText: '重命名' })
    .first()
    .isDisabled()
  const delDisabled = await page
    .locator('div.fixed.z-50 button', { hasText: '删除节点' })
    .first()
    .isDisabled()
  check('只读模式下右键菜单的「重命名」被禁用', renameDisabled)
  check('只读模式下右键菜单的「删除节点」被禁用', delDisabled)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // 折叠这类浏览操作不应被锁。
  // 必须在一个**有子节点**的节点上验证——「折叠分支」对叶子本来就是禁用的。
  if (parentNode) {
    const pbox = await page.locator(`.react-flow__node[data-id="${parentNode.id}"]`).boundingBox()
    await page.mouse.click(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2, { button: 'right' })
    await page.waitForTimeout(300)
    const foldDisabled = await page
      .locator('div.fixed.z-50 button')
      .filter({ hasText: /折叠分支/ })
      .first()
      .isDisabled()
    check(
      `只读模式下「折叠分支」仍可用（它不改内容）`,
      !foldDisabled,
      `在 ${parentNode.id} 上验证`,
    )
  } else {
    check('只读模式下「折叠分支」仍可用（它不改内容）', false, '没找到带子节点的节点')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
}

// ---------------------------------------------------------------- 拖拽单节点
if (target) {
  const box = await page.locator(`.react-flow__node[data-id="${target.id}"]`).boundingBox()
  const before = await page.evaluate(
    (id) => document.querySelector(`.react-flow__node[data-id="${id}"]`).style.transform,
    target.id,
  )
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const after = await page.evaluate(
    (id) => document.querySelector(`.react-flow__node[data-id="${id}"]`).style.transform,
    target.id,
  )
  check('可以单独拖拽某个节点（而不是只能拖画布）', before !== after, `${before} -> ${after}`)
}

// ---------------------------------------------------------------- 拖拽持久化
if (target) {
  const readTransform = (id) =>
    page.evaluate(
      (i) => document.querySelector(`.react-flow__node[data-id="${i}"]`).style.transform,
      id,
    )
  const moved = await readTransform(target.id)

  const hasResetBtn = await page.getByTitle('清除手动拖拽的位置，恢复自动布局').count()
  check('出现过手动摆放后，「整理」按钮才出现', hasResetBtn === 1)

  await page.reload({ waitUntil: 'networkidle' })
  await openVideo(opened)
  const afterReload = await readTransform(target.id)
  check('刷新后手动摆放的位置仍然保留', afterReload === moved, `${moved} vs ${afterReload}`)

  await page.getByTitle('清除手动拖拽的位置，恢复自动布局').click()
  await page.waitForTimeout(600)
  const afterReset = await readTransform(target.id)
  check('「整理」能恢复自动布局', afterReset !== afterReload, `${afterReload} -> ${afterReset}`)
}

// ---------------------------------------------------------------- 框选 + 整体拖拽
const pane = await page.locator('.react-flow__pane').boundingBox()

// 找一块真正的空白：框选必须从画布空白处开始，压在节点上会变成拖节点
const empty = await page.evaluate(
  (r) => {
    for (const dx of [6, 20, 40, 60]) {
      for (const dy of [6, 20, 40, 60]) {
        const el = document.elementFromPoint(r.x + dx, r.y + dy)
        if (el && el.classList.contains('react-flow__pane')) {
          return { x: r.x + dx, y: r.y + dy }
        }
      }
    }
    return null
  },
  pane,
)

if (!empty) {
  check('找到画布空白处用于起手框选', false)
} else {
  // ---- 先验证「默认工具」：用户 2026-10-18 要求左键拖默认是平移 ----
  const toolLabel = () =>
    page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        ['框选', '平移'].includes((x.textContent || '').trim()),
      )
      return b ? (b.textContent || '').trim() : ''
    })
  check('默认「左键拖」是平移', (await toolLabel()) === '平移', await toolLabel())
  const vpTool0 = await page.evaluate(
    () => document.querySelector('.react-flow__viewport').style.transform,
  )
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x + 60, empty.y + 40, { steps: 6 })
  const rectWhilePan = await page.evaluate(
    () => document.querySelectorAll('.react-flow__selection').length,
  )
  await page.mouse.up()
  await page.waitForTimeout(300)
  const vpTool1 = await page.evaluate(
    () => document.querySelector('.react-flow__viewport').style.transform,
  )
  check('默认拖空白是平移画布（视角真的动了）', vpTool0 !== vpTool1, `${vpTool0} -> ${vpTool1}`)
  check('默认拖空白不会拉出选框', rectWhilePan === 0, String(rectWhilePan))

  // 把视角平回去，否则下面那次框选是从一张挪过的图上拉框，能框住几个节点就随机了
  await page.mouse.move(empty.x + 60, empty.y + 40)
  await page.mouse.down()
  await page.mouse.move(empty.x, empty.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(300)

  // 想框选：点工具条那个切换按钮切过去（它显示的是当前模式）
  await ensureTool('select')
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x + 320, empty.y + 300, { steps: 10 })
  // v12 里框选矩形是 .react-flow__selection（不是 .react-flow__nodesselection-rect）
  const rectVisible = await page.evaluate(
    () => document.querySelectorAll('.react-flow__selection').length,
  )
  await page.mouse.up()
  await page.waitForTimeout(400)
  const selected = await page.locator('.react-flow__node.selected').count()
  check('浏览模式下拖动能拉出可见的框选矩形', rectVisible > 0)
  check('框选能一次选中多个节点', selected >= 2, `选中 ${selected} 个`)

  if (selected >= 2) {
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('.react-flow__node.selected')].map((e) =>
        e.getAttribute('data-id'),
      ),
    )
    const readAll = () =>
      page.evaluate(
        (list) =>
          list.map((id) => ({
            id,
            t: document.querySelector(`.react-flow__node[data-id="${id}"]`).style.transform,
          })),
        ids,
      )
    const before = await readAll()
    const head = await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).boundingBox()
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2)
    await page.mouse.down()
    await page.mouse.move(head.x + head.width / 2 + 70, head.y + head.height / 2 + 50, {
      steps: 8,
    })
    await page.mouse.up()
    await page.waitForTimeout(500)
    const after = await readAll()
    const movedCount = after.filter((a, i) => a.t !== before[i].t).length
    check(
      '拖动其中一个，被选中的节点整组跟着移动',
      movedCount >= 2,
      `${movedCount}/${ids.length} 个节点位移`,
    )

    // 整组的新位置也要能存住：只记被拖那一个的话，其余节点刷新后就弹回去了
    await page.reload({ waitUntil: 'networkidle' })
    await openVideo(opened)
    const afterReload = await readAll()
    const kept = afterReload.filter((a, i) => a.t === after[i].t).length
    check(
      '整组摆放的位置刷新后全部保留',
      kept === ids.length,
      `${kept}/${ids.length} 个位置保持`,
    )
  }
}

// 编辑模式：左键拖空白应该平移画布，而不是框选
await page.getByRole('button', { name: '只读' }).click()
await page.waitForTimeout(200)
await ensureTool('pan')
const vpBefore = await page.evaluate(
  () => document.querySelector('.react-flow__viewport').style.transform,
)
// 刷新之后必须重新找一块空白：上一步把 13 个节点整组拖走了，
// 开头算出来的那个点可能已经被节点压住——从节点上按下拖的是节点，
// 视角一动不动，这条断言就会误报成「平移坏了」。
const paneNow = await page.locator('.react-flow__pane').first().boundingBox()
const emptyNow = await page.evaluate((r) => {
  for (const dx of [6, 20, 40, 60, 90, 120]) {
    for (const dy of [6, 20, 40, 60, 90, 120]) {
      const el = document.elementFromPoint(r.x + dx, r.y + dy)
      if (el && el.classList.contains('react-flow__pane')) return { x: r.x + dx, y: r.y + dy }
    }
  }
  return null
}, paneNow)
if (emptyNow) {
  await page.mouse.move(emptyNow.x, emptyNow.y)
  await page.mouse.down()
  await page.mouse.move(emptyNow.x + 80, emptyNow.y + 60, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}
const vpAfter = await page.evaluate(
  () => document.querySelector('.react-flow__viewport').style.transform,
)
const selAfterPan = await page.locator('.react-flow__node.selected').count()
check('编辑模式下拖空白是平移画布', vpBefore !== vpAfter, `${vpBefore} -> ${vpAfter}`)
check(
  '编辑模式下拖空白不会误框选',
  selAfterPan === 0,
  `仍选中 ${selAfterPan} 个`,
)
await page.getByRole('button', { name: '编辑中' }).click()
await page.waitForTimeout(300)

// ---------------------------------------------------------------- 顶部固定操作条
{
  const bar = 'div.shrink-0.flex.items-center.flex-wrap'
  // 操作条上有的按钮是纯图标（删除 / 折叠 / 新增笔记），没有文字节点，
  // 只能靠 aria-label 认——这里两种都试，谁命中用谁
  const btn = (name) =>
    page
      .locator(`${bar} button`)
      .filter({ hasText: name })
      .or(page.locator(`${bar} button[aria-label="${name}"]`))
      .first()

  // 只读模式：操作条整条不出现——出现一条永远点不动的按钮纯属占地方
  check('只读模式下操作条不出现', (await page.locator(bar).count()) === 0)

  await page.getByRole('button', { name: '只读' }).click()
  await page.waitForTimeout(300)

  // 编辑模式但没选中任何节点 → 操作条同样不出现
  check(
    '编辑模式下未选中节点时操作条不出现',
    (await page.locator(bar).count()) === 0,
  )

  // 选中一个节点后操作条出现，按钮生效
  const pick = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.react-flow__node')].find((e) =>
      e.getAttribute('data-id')?.startsWith('nd'),
    )
    return el ? el.getAttribute('data-id') : null
  })
  const targetBox = await page.locator(`.react-flow__node[data-id="${pick}"]`).boundingBox()
  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
  await page.waitForTimeout(300)
  check('编辑模式下选中节点后操作条出现', (await page.locator(bar).count()) === 1)
  check('编辑模式下选中节点后「改名」可点', await btn('改名').isEnabled())
  check('编辑模式下选中节点后「删除」可点', await btn('删除').isEnabled())

  // 点「改名」应该在该节点上出现输入框，并且操作条本身不挡住节点
  await btn('改名').click()
  await page.waitForTimeout(400)
  const inputCount = await page
    .locator(`.react-flow__node[data-id="${pick}"] input`)
    .count()
  check('点操作条「改名」能在该节点上打开输入框', inputCount > 0)

  // 操作条必须在画布上方，而不是钉在某个节点下方
  const barBox = await page.locator(bar).first().boundingBox()
  const nodeBox = await page.locator(`.react-flow__node[data-id="${pick}"]`).boundingBox()
  check(
    '操作条固定位于画布上方（不在节点下方）',
    barBox.y + barBox.height <= nodeBox.y + nodeBox.height,
    `操作条底 ${Math.round(barBox.y + barBox.height)} vs 节点底 ${Math.round(nodeBox.y + nodeBox.height)}`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '编辑中' }).click()
  await page.waitForTimeout(300)
}

// ---------------------------------------------------------------- 平移工具独立于模式
{
  const pane = await page.locator('.react-flow__pane').boundingBox()
  const empty2 = await page.evaluate(
    (r) => {
      for (const dx of [6, 20, 40]) {
        for (const dy of [6, 20, 40]) {
          const el = document.elementFromPoint(r.x + dx, r.y + dy)
          if (el && el.classList.contains('react-flow__pane')) return { x: r.x + dx, y: r.y + dy }
        }
      }
      return null
    },
    pane,
  )

  // 只读 + 平移工具 → 拖空白应该挪动画布
  await ensureTool('pan')
  await page.waitForTimeout(200)
  const vp1 = await page.evaluate(
    () => document.querySelector('.react-flow__viewport').style.transform,
  )
  const selBefore = await page.locator('.react-flow__node.selected').count()
  await page.mouse.move(empty2.x, empty2.y)
  await page.mouse.down()
  await page.mouse.move(empty2.x + 90, empty2.y + 70, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const vp2 = await page.evaluate(
    () => document.querySelector('.react-flow__viewport').style.transform,
  )
  const selAfter = await page.locator('.react-flow__node.selected').count()
  check('只读模式下切到「平移」也能拖动画布', vp1 !== vp2, `${vp1} -> ${vp2}`)
  check(
    '平移工具下拖空白不会框选',
    selAfter <= selBefore,
    `拖前 ${selBefore} 个 → 拖后 ${selAfter} 个`,
  )

  // 编辑 + 框选工具 → 拖空白应该框选
  await page.getByRole('button', { name: '只读' }).click()
  await page.waitForTimeout(200)
  await ensureTool('select')
  await page.waitForTimeout(200)
  // 前面的用例把画布平移/缩放过，先「适应画布」把整棵树拉回视野，
  // 再重新找空白处——拿旧坐标当起点，框出来的可能是一块没有节点的空地
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(500)
  const pane3 = await page.locator('.react-flow__pane').boundingBox()
  const empty3 = await findEmpty()
  if (!empty3) {
    check('编辑模式下切到「框选」也能框选', false, '找不到画布空白处')
  } else {
  await page.mouse.move(empty3.x, empty3.y)
  await page.mouse.down()
  // 框到画布右下角：覆盖整块可视区，不用猜节点在哪
  await page.mouse.move(pane3.x + pane3.width - 8, pane3.y + pane3.height - 8, { steps: 10 })
  const rectN = await page.evaluate(
    () => document.querySelectorAll('.react-flow__selection').length,
  )
  await page.mouse.up()
  await page.waitForTimeout(300)
  const selEdit = await page.locator('.react-flow__node.selected').count()
  check(
    '编辑模式下切到「框选」也能框选',
    rectN > 0 && selEdit >= 2,
    `选中 ${selEdit} 个 · 选框 ${rectN} 个 · 起点 ${Math.round(empty3.x)},${Math.round(empty3.y)}`,
  )

  await page.getByRole('button', { name: '编辑中' }).click()
  await page.waitForTimeout(300)
  }
}

// ---------------------------------------------------------------- 全部收起
const visibleBefore = await page.locator('.react-flow__node').count()
await page.getByTitle('全部收起，只剩根节点').click()
await page.waitForTimeout(500)
const visibleAfter = await page.locator('.react-flow__node').count()
check(
  '「收起」能收起到只剩根节点',
  visibleAfter === 1 && visibleBefore > 1,
  `收起前 ${visibleBefore} 个 → 收起后 ${visibleAfter} 个`,
)

await page.getByTitle('展开所有分支').click()
await page.waitForTimeout(500)
const visibleExpanded = await page.locator('.react-flow__node').count()
check(
  '「展开」能把所有节点恢复回来',
  visibleExpanded === visibleBefore,
  `${visibleAfter} → ${visibleExpanded}（原 ${visibleBefore}）`,
)

await browser.close()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
