import type { MindMapNode } from '../types'

/**
 * 把导图树摆成**中心发散**的思维导图布局：根居中，一级分支左右交替生长，
 * 每个一级分支独占一种颜色。
 *
 * 为什么必须换掉之前的「左对齐逻辑图」：
 *   根节点顶在最左边、全部向右生长，是 XMind 九种结构里的「逻辑图」，
 *   不是思维导图。中心发散有两个实打实的好处——纵向高度直接减半
 *   （分支分摊到两侧），以及「从中心往外读」天然表达了层级归属，
 *   不再需要靠箭头去猜方向。
 *
 * 布局规则固定（列按深度、行按叶子顺序、父居中于子），40 行核心代码就够，
 * 不需要引入 dagre / elkjs 这类通用图布局引擎。
 *
 * 节点支持**单独缩放**（scale）：放大时宽高与行距一起变大，
 * 所以所有尺寸计算都要乘各自的 scale，不能用常量一刀切。
 */

const NODE_H = 40
const ROOT_H = 50
const V_GAP = 12
const H_GAP = 52
const CHAR_W = 14
const MIN_W = 96
const MAX_W = 268

/** 一级分支配色。相邻色相拉开距离，保证任何两个分支放在一起都能区分。 */
export const BRANCH_COLORS = [
  '#2563eb',
  '#db2777',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#65a30d',
]

export const ROOT_COLOR = '#4f46e5'

export function branchColorOf(branch: number): string {
  if (branch < 0) return ROOT_COLOR
  return BRANCH_COLORS[branch % BRANCH_COLORS.length]
}

/** 给 hex 颜色加透明度。节点描边要用「同色但更浅」，不能用灰色，否则层级感就没了。 */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface LaidOutNode {
  id: string
  label: string
  start: number | null
  depth: number
  x: number
  y: number
  width: number
  height: number
  parentId: string | null
  scale: number
  /** 一级分支序号；根节点为 -1。颜色由它决定，子分支自动继承 */
  branch: number
  /** -1 左 / 0 根 / 1 右 */
  side: -1 | 0 | 1
  /** 该分支的总色（含根节点，根节点用 ROOT_COLOR） */
  color: string
  hasChildren: boolean
  collapsed: boolean
  /** 折叠时被藏起来的后代数量，显示在折叠圆点上 */
  hiddenCount: number
}

export interface LayoutResult {
  nodes: LaidOutNode[]
  /** 可见节点的深度优先顺序：方向键上下导航与大纲视图都按这个顺序走 */
  order: string[]
  /** 自动布局算出的原始位置（未叠加手动偏移）。拖拽结束时用它反算偏移量 */
  base: Map<string, { x: number; y: number }>
  totalWidth: number
  totalHeight: number
  maxDepth: number
  visibleCount: number
  hiddenCount: number
}

/** 当前正在编辑哪个节点的哪一栏 */
export type EditingTarget = { id: string; field: 'label' | 'time' } | null

/**
 * 鼠标左键在画布空白处拖拽的含义。
 *
 * 平移画布原本被绑死在编辑模式上，结果只读模式下想挪一下视角只能靠空格——
 * 这是典型的「把工具锁进模式里」。工具应该独立于模式，用户自己说了算。
 */
export type MindTool = 'select' | 'pan'

/**
 * 导图视图（画布 / 大纲）共用的操作集。
 *
 * 抽出来的原因很实际：大纲视图和画布视图是同一棵树的两副皮，
 * 若各自实现一套「改名 / 加子节点 / 折叠」，两边行为迟早会漂移——
 * 比如大纲里能删、画布里不能删。由容器统一产出，两个视图只负责渲染。
 */
export interface MindViewActions {
  seek: (t: number) => void
  select: (id: string | null) => void
  beginEdit: (id: string, field: 'label' | 'time') => void
  cancelEdit: () => void
  commitLabel: (id: string, label: string) => void
  commitTime: (id: string, seconds: number | null) => void
  addChild: (id: string) => void
  addSibling: (id: string) => void
  remove: (id: string) => void
  rescale: (id: string, delta: number) => void
  toggleCollapse: (id: string) => void
  /** 连同所有后代一并折叠（节点上 Shift+点击） */
  collapseDeep: (id: string) => void
  focusBranch: (id: string | null) => void
  openMenu: (id: string, x: number, y: number) => void
}

export interface LayoutOptions {
  /** 被折叠的节点 id */
  collapsed?: ReadonlySet<string>
  /** 聚焦模式：只显示该节点所在分支（含根到它的路径） */
  focusId?: string | null
  /** 即便处于折叠态也要展开的节点——搜索命中时用它把祖先自动撑开 */
  forceExpand?: ReadonlySet<string>
  /**
   * 鼠标拖拽产生的**相对**偏移，叠加到自动布局算出的位置上。
   *
   * 存相对量而不是绝对坐标：折叠别的分支会让自动布局基准位置整体移动，
   * 存绝对值的话一折叠手动摆好的节点就飞走了；存相对偏移则跟着整条分支一起挪。
   */
  offsets?: ReadonlyMap<string, { dx: number; dy: number }>
}

const CJK_RE = /[一-龥　-〿＀-￯]/

/**
 * 估算节点宽度。
 *
 * pad 不能只算内边距：节点右侧常驻一个时间戳徽章（约 40px），
 * 不算它的话标签会被挤到过早截断——真机验证时「种族属性」这种四字词
 * 都显示成了「种族属…」，就是这个原因。根节点还多一个播放标记和更大字号。
 */
function estimateWidth(label: string, scale: number, pad: number): number {
  let w = 0
  for (const ch of label) {
    w += CJK_RE.test(ch) ? 1 : 0.55
  }

  const base = Math.max(MIN_W, Math.min(MAX_W, w * CHAR_W + pad))
  return Math.round(base * scale)
}

interface RawEntry {
  id: string
  label: string
  start: number | null
  depth: number
  parentId: string | null
  branch: number
  side: -1 | 0 | 1
  scale: number
  width: number
  height: number
  x: number
  y: number
  childIds: string[]
  descendants: number
}

export function layoutMindMap(tree: MindMapNode, options: LayoutOptions = {}): LayoutResult {
  const collapsed = options.collapsed ?? new Set<string>()
  const forceExpand = options.forceExpand ?? new Set<string>()
  const focusId = options.focusId ?? null
  const offsets = options.offsets

  // ---------------------------------------------------------------- 第一遍：建全量索引
  // 先不管折叠，把整棵树登记下来。这样折叠节点才能报出「我藏了多少个后代」，
  // 搜索时也才有完整结构去算命中节点的祖先链。
  const entries: RawEntry[] = []
  const byId = new Map<string, RawEntry>()
  let seq = 0

  function build(
    node: MindMapNode,
    depth: number,
    parentId: string | null,
    branch: number,
    side: -1 | 0 | 1,
  ): string {
    const scale = typeof node.scale === 'number' && node.scale > 0 ? node.scale : 1
    const id = node.id || `n${seq}`
    seq += 1
    const e: RawEntry = {
      id,
      label: node.label,
      start: node.start ?? null,
      depth,
      parentId,
      branch,
      side,
      scale,
      width: estimateWidth(node.label, scale, depth === 0 ? 112 : 70),
      height: Math.round((depth === 0 ? ROOT_H : NODE_H) * scale),
      x: 0,
      y: 0,
      childIds: [],
      descendants: 0,
    }
    entries.push(e)
    byId.set(id, e)
    const kids = node.children ?? []
    kids.forEach((kid, i) => {
      // 一级分支左右交替：偶数序号向右、奇数向左。
      // 交替（而不是「前半右后半左」）能让两侧高度始终接近，
      // 不会一边挤成一摞、另一边空半屏。
      const kidSide: -1 | 0 | 1 = depth === 0 ? (i % 2 === 0 ? 1 : -1) : side
      const kidBranch = depth === 0 ? i : branch
      e.childIds.push(build(kid, depth + 1, id, kidBranch, kidSide))
    })
    return id
  }

  const rootId = build(tree, 0, null, -1, 0)

  function countDescendants(id: string): number {
    const e = byId.get(id)
    if (!e) return 0
    let n = 0
    for (const c of e.childIds) n += 1 + countDescendants(c)
    return n
  }
  for (const e of entries) e.descendants = countDescendants(e.id)

  // ---------------------------------------------------------------- 第二遍：决定谁可见
  const keep = new Set<string>()

  if (focusId && byId.has(focusId)) {
    // 聚焦：保留「根 → 目标」的路径，以及目标自身的整棵子树
    let cur: string | null = focusId
    while (cur) {
      keep.add(cur)
      cur = byId.get(cur)?.parentId ?? null
    }
    const stack = [focusId]
    while (stack.length) {
      const id = stack.pop() as string
      for (const c of byId.get(id)?.childIds ?? []) {
        keep.add(c)
        stack.push(c)
      }
    }
  } else {
    for (const e of entries) keep.add(e.id)
  }

  const isCollapsed = (id: string) => collapsed.has(id) && !forceExpand.has(id)

  // 自顶向下：父节点折叠，整棵子树就不可见
  const visible: RawEntry[] = []
  ;(function walkDown(id: string, ancestorCollapsed: boolean) {
    const e = byId.get(id)
    if (!e || !keep.has(id)) return
    if (ancestorCollapsed) return
    visible.push(e)
    const selfCollapsed = isCollapsed(id)
    for (const c of e.childIds) walkDown(c, ancestorCollapsed || selfCollapsed)
  })(rootId, false)

  const visibleIds = new Set(visible.map((e) => e.id))
  const order: string[] = []
  ;(function walkOrder(id: string) {
    if (!visibleIds.has(id)) return
    order.push(id)
    for (const c of byId.get(id)?.childIds ?? []) walkOrder(c)
  })(rootId)

  if (visible.length === 0) {
    return {
      nodes: [],
      order: [],
      base: new Map(),
      totalWidth: 0,
      totalHeight: 0,
      maxDepth: 0,
      visibleCount: 0,
      hiddenCount: 0,
    }
  }

  // ---------------------------------------------------------------- 第三遍：列宽与列 x
  // 左右两侧各自算列宽：右侧最长标签不该去撑开左侧的列，否则横向白扔一大片。
  const colW: Record<string, Map<number, number>> = { r: new Map(), l: new Map() }
  for (const e of visible) {
    if (e.depth === 0) continue
    const m = e.side === 1 ? colW.r : colW.l
    m.set(e.depth, Math.max(m.get(e.depth) ?? 0, e.width))
  }

  const dist: Record<string, Map<number, number>> = { r: new Map(), l: new Map() }
  for (const key of ['r', 'l'] as const) {
    const m = colW[key]
    const d = dist[key]
    let acc = H_GAP
    const depths = [...m.keys()].sort((a, b) => a - b)
    for (const dep of depths) {
      d.set(dep, acc)
      acc += (m.get(dep) ?? 0) + H_GAP
    }
  }

  const root = byId.get(rootId)
  const rootW = root?.width ?? MIN_W

  for (const e of visible) {
    if (e.depth === 0) {
      e.width = rootW
      continue
    }
    const key = e.side === 1 ? 'r' : 'l'
    const d = dist[key].get(e.depth) ?? H_GAP
    // 节点保留自然宽度（不做列内统一加宽）：右侧列左对齐、左侧列右对齐，
    // 朝向父节点的那一侧成一条直线即可。强行统一列宽会让短标签节点里空出一大片。
    if (e.side === 1) e.x = rootW / 2 + d
    else e.x = -rootW / 2 - d - e.width
  }

  // ---------------------------------------------------------------- 第四遍：纵向排列
  // 叶子顺序往下排，父节点居中于首尾子节点；子树整体下移避让上一棵子树。
  // parentY 顶到 cursor 之上时，必须把**整棵子树**一起下移，只挪父节点会让连线打结。
  function placeSubtree(id: string, cursor: { v: number }): { top: number; bottom: number } {
    const e = byId.get(id)
    if (!e) return { top: cursor.v, bottom: cursor.v }
    const kids = e.childIds.filter((c) => visibleIds.has(c))

    if (kids.length === 0) {
      e.y = cursor.v
      cursor.v += e.height + V_GAP
      return { top: e.y, bottom: e.y + e.height }
    }

    let top = Infinity
    let bottom = -Infinity
    for (const k of kids) {
      const r = placeSubtree(k, cursor)
      top = Math.min(top, r.top)
      bottom = Math.max(bottom, r.bottom)
    }

    let y = (top + bottom) / 2 - e.height / 2
    if (y < cursor.v) {
      const shift = cursor.v - y
      for (const k of kids) shiftSubtree(k, shift)
      top += shift
      bottom += shift
      y += shift
    }
    e.y = y
    cursor.v = Math.max(cursor.v, bottom + V_GAP)
    return { top: Math.min(top, y), bottom: Math.max(bottom, y + e.height) }
  }

  function shiftSubtree(id: string, dy: number) {
    const e = byId.get(id)
    if (!e) return
    e.y += dy
    for (const c of e.childIds) {
      if (visibleIds.has(c)) shiftSubtree(c, dy)
    }
  }

  // 两侧各自从 0 开始堆，堆完再把整摞挪到以根为中心——
  // 这样根始终落在整张图的垂直中心，左右两摞各自向上下对称展开。
  for (const side of [1, -1] as const) {
    const roots = (byId.get(rootId)?.childIds ?? []).filter(
      (c) => visibleIds.has(c) && byId.get(c)?.side === side,
    )
    const cursor = { v: 0 }
    let top = Infinity
    let bottom = -Infinity
    for (const c of roots) {
      const r = placeSubtree(c, cursor)
      top = Math.min(top, r.top)
      bottom = Math.max(bottom, r.bottom)
    }
    if (!Number.isFinite(top)) continue
    const shift = -(top + bottom) / 2
    for (const c of roots) shiftSubtree(c, shift)
  }

  if (root) root.y = -root.height / 2

  // ---------------------------------------------------------------- 归一化到左上角原点
  // 只在这里归一化一次。手动偏移在**之后**叠加且不再归零：
  // 若把偏移也算进 minX，用户拖走一个节点会让整张图的坐标基准跟着平移，
  // 表现为「我拖 A，B C D 全都动了一下」，非常莫名其妙。
  let minX = Infinity
  let minY = Infinity
  for (const e of visible) {
    minX = Math.min(minX, e.x)
    minY = Math.min(minY, e.y)
  }
  for (const e of visible) {
    e.x -= minX
    e.y -= minY
  }

  const base = new Map<string, { x: number; y: number }>()
  for (const e of visible) base.set(e.id, { x: e.x, y: e.y })

  for (const e of visible) {
    const o = offsets?.get(e.id)
    if (!o) continue
    e.x += o.dx
    e.y += o.dy
  }

  let maxX = -Infinity
  let maxY = -Infinity
  let bx = Infinity
  let by = Infinity
  for (const e of visible) {
    bx = Math.min(bx, e.x)
    by = Math.min(by, e.y)
    maxX = Math.max(maxX, e.x + e.width)
    maxY = Math.max(maxY, e.y + e.height)
  }

  const nodes: LaidOutNode[] = visible.map((e) => ({
    id: e.id,
    label: e.label,
    start: e.start,
    depth: e.depth,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
    parentId: e.parentId,
    scale: e.scale,
    branch: e.branch,
    side: e.side,
    color: branchColorOf(e.branch),
    hasChildren: e.childIds.length > 0,
    collapsed: isCollapsed(e.id),
    hiddenCount: isCollapsed(e.id) ? e.descendants : 0,
  }))

  const hiddenCount = entries.length - visible.length

  return {
    nodes,
    order,
    base,
    totalWidth: maxX - bx,
    totalHeight: maxY - by,
    maxDepth: Math.max(...visible.map((e) => e.depth)),
    visibleCount: visible.length,
    hiddenCount,
  }
}
