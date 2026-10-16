/**
 * 用真实浏览器点击验证导图的鼠标交互。
 *
 * 为什么要这个脚本：这一版导图踩过一个「节点点击没反应」的坑——
 * 悬浮工具条用 opacity-0 隐藏，但它**依然接收鼠标事件**，正好压在
 * 下方兄弟节点的上边缘（节点间距 12px，工具条占 4~26px）。
 * 静态审查看不出来，只有真的把鼠标放在那个位置问「这个点上是谁」才能发现。
 *
 * 用法：NODE_PATH=<workspace>/node_modules node frontend/scripts/probe-mindmap.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const EXECUTABLE =
  'C:/Users/momo/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch({ executablePath: EXECUTABLE })
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
await page.goto('http://127.0.0.1:5273/smoke.html', { waitUntil: 'networkidle' })
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
  // 找一个肯定带时间戳的节点（内部有 tabular-nums 的时间徽章且不是「设时间」）
  for (const el of nodes) {
    const badge = el.querySelector('button.tabular-nums')
    if (badge && !badge.textContent.includes('设时间')) {
      return { id: el.getAttribute('data-id'), text: badge.textContent }
    }
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
  const seekTop = await page.evaluate(() => window.__log.seek.slice())
  check('点击节点上边缘能触发跳转', seekTop.length === 1, `seek=${JSON.stringify(seekTop)}`)

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
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
  // 折叠这类浏览操作不应被锁
  const foldDisabled = await page
    .locator('div.fixed.z-50 button')
    .filter({ hasText: /折叠分支/ })
    .first()
    .isDisabled()
  check('只读模式下「折叠分支」仍可用（它不改内容）', !foldDisabled)
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
  await page.waitForSelector('.react-flow__node', { timeout: 15000 })
  await page.waitForTimeout(600)
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
    await page.waitForSelector('.react-flow__node', { timeout: 15000 })
    await page.waitForTimeout(600)
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
const vpBefore = await page.evaluate(
  () => document.querySelector('.react-flow__viewport').style.transform,
)
if (empty) {
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x + 80, empty.y + 60, { steps: 8 })
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
  const btn = (name) => page.locator(`${bar} button`, { hasText: name }).first()

  // 只读模式：整条按钮都不可点
  check('只读模式下操作条「改名」不可点', await btn('改名').isDisabled())
  check('只读模式下操作条「删除」不可点', await btn('删除').isDisabled())

  await page.getByRole('button', { name: '只读' }).click()
  await page.waitForTimeout(300)

  // 编辑模式但没选中任何节点 → 依然不可用
  check(
    '编辑模式下未选中节点时「改名」仍不可点',
    await btn('改名').isDisabled(),
  )

  // 选中一个节点后按钮生效
  const pick = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.react-flow__node')].find((e) =>
      e.getAttribute('data-id')?.startsWith('nd'),
    )
    return el ? el.getAttribute('data-id') : null
  })
  const targetBox = await page.locator(`.react-flow__node[data-id="${pick}"]`).boundingBox()
  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
  await page.waitForTimeout(300)
  check('编辑模式下选中节点后「改名」可点', !(await btn('改名').isDisabled()))
  check('编辑模式下选中节点后「删除」可点', !(await btn('删除').isDisabled()))

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
  await page.getByRole('button', { name: '平移', exact: true }).click()
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
  await page.getByRole('button', { name: '框选', exact: true }).click()
  await page.waitForTimeout(200)
  await page.mouse.move(empty2.x, empty2.y)
  await page.mouse.down()
  await page.mouse.move(empty2.x + 320, empty2.y + 300, { steps: 10 })
  const rectN = await page.evaluate(
    () => document.querySelectorAll('.react-flow__selection').length,
  )
  await page.mouse.up()
  await page.waitForTimeout(300)
  const selEdit = await page.locator('.react-flow__node.selected').count()
  check('编辑模式下切到「框选」也能框选', rectN > 0 && selEdit >= 2, `选中 ${selEdit} 个`)

  await page.getByRole('button', { name: '编辑中' }).click()
  await page.waitForTimeout(300)
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
