/**
 * 布局自检：中心发散布局最容易出的两类错——节点重叠、根没落在垂直中心。
 * 这两个错在浏览器里表现为「方框叠在一起」「整张图偏上」，很难一眼定位，
 * 所以在这里用几何断言直接卡住。
 *
 * 融合后端到 frontend/scripts/ 下运行：node scripts/check-layout.mjs
 * （相对路径按 frontend/ 解析，源码在 src/videomind/lib/mindmapLayout.ts）
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'vm-layout-'))
const out = join(tmp, 'ml.mjs')
execFileSync(
  process.execPath,
  [
    join('node_modules', 'esbuild', 'bin', 'esbuild'),
    'src/videomind/lib/mindmapLayout.ts',
    '--format=esm',
    `--outfile=${out}`,
    '--log-level=error',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
)
const { layoutMindMap } = await import(pathToFileURL(out).href)
rmSync(tmp, { recursive: true, force: true })

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function overlaps(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const hit =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      if (hit) return `${a.id}(${a.label}) 与 ${b.id}(${b.label})`
    }
  }
  return null
}

// ---------------------------------------------------------------- 用例 1：典型的视频章节树
const tree = {
  id: 'n0',
  label: '一小时讲透 Transformer',
  start: 0,
  children: [
    {
      id: 'n1',
      label: '开场与大纲',
      start: 0,
      children: [
        { id: 'n5', label: '为什么值得学', start: 12 },
        { id: 'n6', label: '前置知识', start: 95 },
      ],
    },
    {
      id: 'n2',
      label: '注意力机制',
      start: 420,
      children: [
        { id: 'n7', label: 'QKV 直觉', start: 480 },
        { id: 'n8', label: '缩放点积', start: 700 },
        { id: 'n9', label: '多头并行', start: 880 },
      ],
    },
    {
      id: 'n3',
      label: '编码器与解码器',
      start: 1200,
      children: [
        { id: 'n10', label: '残差与归一化', start: 1260 },
        { id: 'n11', label: '掩码机制', start: 1500 },
      ],
    },
    {
      id: 'n4',
      label: '训练技巧与总结',
      start: 1900,
      children: [{ id: 'n12', label: '学习率预热', start: 1950 }],
    },
  ],
}

const full = layoutMindMap(tree)
console.log(`用例1 全展开：${full.visibleCount} 个可见节点`)

check('无节点重叠', overlaps(full.nodes) === null, overlaps(full.nodes) ?? '')
check('总宽高为正', full.totalWidth > 0 && full.totalHeight > 0)

const root = full.nodes.find((n) => n.id === 'n0')
const rootCenter = root.y + root.height / 2
const mapCenter = full.totalHeight / 2
check(
  '根节点垂直居中（偏差 < 12px）',
  Math.abs(rootCenter - mapCenter) < 12,
  `根中心 ${rootCenter.toFixed(1)} vs 图中心 ${mapCenter.toFixed(1)}`,
)

const rights = full.nodes.filter((n) => n.side === 1)
const lefts = full.nodes.filter((n) => n.side === -1)
check('一级分支分摊到两侧', rights.length > 0 && lefts.length > 0, `右 ${rights.length} 左 ${lefts.length}`)
check(
  '根节点左右都有子节点（双向发散）',
  full.nodes.some((n) => n.parentId === 'n0' && n.side === 1) &&
    full.nodes.some((n) => n.parentId === 'n0' && n.side === -1),
)

const branchColors = new Set(
  full.nodes.filter((n) => n.depth === 1).map((n) => n.color),
)
check('每个一级分支颜色互不相同', branchColors.size === 4, `实际 ${branchColors.size} 种`)
const childInherits = full.nodes.find((n) => n.id === 'n7')
const parentBranch = full.nodes.find((n) => n.id === 'n2')
check('子分支继承父分支配色', childInherits.color === parentBranch.color)

// ---------------------------------------------------------------- 用例 2：折叠
const collapsed = layoutMindMap(tree, { collapsed: new Set(['n1', 'n2']) })
console.log(`用例2 折叠 n1/n2：${collapsed.visibleCount} 可见，隐藏 ${collapsed.hiddenCount}`)
check('折叠后隐藏数正确', collapsed.hiddenCount === 5, `实际 ${collapsed.hiddenCount}`)
check('折叠后无重叠', overlaps(collapsed.nodes) === null, overlaps(collapsed.nodes) ?? '')
const c1 = collapsed.nodes.find((n) => n.id === 'n1')
check('折叠节点带出隐藏后代数量', c1.collapsed && c1.hiddenCount === 2, `hiddenCount=${c1.hiddenCount}`)
check('折叠后图更矮', collapsed.totalHeight < full.totalHeight)

// ---------------------------------------------------------------- 用例 3：聚焦
const focused = layoutMindMap(tree, { focusId: 'n2' })
console.log(`用例3 聚焦 n2：${focused.visibleCount} 可见`)
check('聚焦只留该分支 + 根路径', focused.visibleCount === 5, `实际 ${focused.visibleCount}`)
check(
  '聚焦包含根节点',
  focused.nodes.some((n) => n.id === 'n0'),
)
check(
  '聚焦排除兄弟分支',
  !focused.nodes.some((n) => ['n3', 'n10', 'n11', 'n12'].includes(n.id)),
)
check('聚焦后无重叠', overlaps(focused.nodes) === null, overlaps(focused.nodes) ?? '')

// ---------------------------------------------------------------- 用例 4：搜索强制展开
const force = layoutMindMap(tree, {
  collapsed: new Set(['n1', 'n2']),
  forceExpand: new Set(['n2']),
})
check(
  'forceExpand 能撑开被折叠的祖先',
  force.nodes.some((n) => n.id === 'n7'),
)
check('forceExpand 后无重叠', overlaps(force.nodes) === null, overlaps(force.nodes) ?? '')

// ---------------------------------------------------------------- 用例 5：手动拖拽偏移
const dragged = layoutMindMap(tree, { offsets: new Map([['n7', { dx: 80, dy: -40 }]]) })
const baseRun = layoutMindMap(tree)
const moved = dragged.nodes.find((n) => n.id === 'n7')
const base7 = baseRun.nodes.find((n) => n.id === 'n7')
check(
  '拖拽偏移按相对量叠加到自动布局位置',
  moved.x === base7.x + 80 && moved.y === base7.y - 40,
  `期望 ${base7.x + 80},${base7.y - 40} 实际 ${moved.x},${moved.y}`,
)
const untouched = dragged.nodes.find((n) => n.id === 'n8')
const base8 = baseRun.nodes.find((n) => n.id === 'n8')
check(
  '拖走一个节点不会带着其它节点一起漂移',
  untouched.x === base8.x && untouched.y === base8.y,
  `n8 ${base8.x},${base8.y} -> ${untouched.x},${untouched.y}`,
)

// ---------------------------------------------------------------- 用例 6：单节点节点
const single = layoutMindMap({ id: 'r', label: '只有一个根', start: null })
check('单节点可用', single.visibleCount === 1 && single.totalWidth > 0)
check('单节点根在原位', single.nodes[0].x === 0 && single.nodes[0].y === 0)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
