import type { MindMapNode } from '../types'

/**
 * 把后端返回的导图树摆成「从左到右」的层次布局。
 *
 * 为什么自己写而不引 dagre / elkjs：
 *   思维导图的布局规则其实很固定——列按深度、行按叶子顺序——
 *   40 行代码就能得到干净且可预测的结果，还能按中文字宽自适应节点宽度。
 *   引一个几十 KB 的通用图布局引擎来做这件事属于杀鸡用牛刀。
 *
 * 节点支持**单独缩放**（scale）：放大时宽高与行距一起变大，
 * 所以布局里所有尺寸计算都要乘上各自的 scale，不能再用常量一刀切。
 */

const NODE_H = 46
const V_GAP = 14
const H_GAP = 56
const CHAR_W = 15
const PAD_X = 30
const MIN_W = 76
const MAX_W = 280

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
}

export interface LayoutResult {
  nodes: LaidOutNode[]
  totalWidth: number
  totalHeight: number
  maxDepth: number
}

/** 中文字符按 1 个字宽、西文按 0.55 估算，避免节点文字被截断或留大片空白。 */
function estimateWidth(label: string, scale: number): number {
  let w = 0
  for (const ch of label) {
    w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55
  }
  const base = Math.max(MIN_W, Math.min(MAX_W, w * CHAR_W + PAD_X))
  return Math.round(base * scale)
}

export function layoutMindMap(tree: MindMapNode): LayoutResult {
  const flat: LaidOutNode[] = []
  let seq = 0

  // 第一遍：展开成扁平数组，顺带算出每个节点的宽度与深度
  function collect(node: MindMapNode, depth: number, parentId: string | null): string {
    const scale = typeof node.scale === 'number' && node.scale > 0 ? node.scale : 1
    const id = node.id || `n${seq}`
    seq += 1
    const entry: LaidOutNode = {
      id,
      label: node.label,
      start: node.start ?? null,
      depth,
      x: 0,
      y: 0,
      width: estimateWidth(node.label, scale),
      height: Math.round(NODE_H * scale),
      parentId,
      scale,
    }
    flat.push(entry)
    const kids = node.children ?? []
    for (const child of kids) {
      collect(child, depth + 1, id)
    }
    return id
  }

  collect(tree, 0, null)

  if (flat.length === 0) {
    return { nodes: [], totalWidth: 0, totalHeight: 0, maxDepth: 0 }
  }

  // 列宽取该层最宽的节点，保证同一列左对齐且不重叠
  const colW: number[] = []
  for (const e of flat) {
    colW[e.depth] = Math.max(colW[e.depth] ?? 0, e.width)
  }

  const colX: number[] = []
  let acc = 0
  for (let d = 0; d < colW.length; d++) {
    colX[d] = acc
    acc += (colW[d] ?? 0) + H_GAP
  }

  // 第二遍：叶子节点按顺序往下排，父节点居中于其子节点
  const byId = new Map(flat.map((e) => [e.id, e]))
  const childrenOf = new Map<string, string[]>()
  for (const e of flat) {
    if (!e.parentId) continue
    const arr = childrenOf.get(e.parentId) ?? []
    arr.push(e.id)
    childrenOf.set(e.parentId, arr)
  }

  let cursorY = 0
  function assignY(id: string): number {
    const e = byId.get(id)!
    const kids = childrenOf.get(id) ?? []
    if (kids.length === 0) {
      e.y = cursorY
      cursorY += e.height + V_GAP
    } else {
      for (const kid of kids) assignY(kid)
      const first = byId.get(kids[0])!
      const last = byId.get(kids[kids.length - 1])!
      // 父节点对齐「首尾子节点中心」的中点，而不是首节点顶边——
      // 子节点高度不一致（放大过）时才不会明显偏上
      e.y = Math.round(first.y + (last.y + last.height / 2 - first.y) / 2 - e.height / 2)
      cursorY = Math.max(cursorY, e.y + e.height + V_GAP)
    }
    return e.y
  }
  assignY(flat[0].id)

  for (const e of flat) {
    e.x = colX[e.depth]
  }

  // 第三遍：同列内消除重叠。
  // 把某个父节点放大到 2 倍后，它可能向上顶到上一个父节点——
  // 只在有人调过缩放时才可能出现，但不处理就会看到两个方框叠在一起。
  const columns = new Map<number, LaidOutNode[]>()
  for (const e of flat) {
    const arr = columns.get(e.depth) ?? []
    arr.push(e)
    columns.set(e.depth, arr)
  }
  let bottom = 0
  for (const [, col] of columns) {
    col.sort((a, b) => a.y - b.y)
    for (const e of col) {
      if (e.y < bottom) e.y = bottom
      bottom = e.y + e.height + V_GAP
    }
    bottom = 0
  }

  const maxBottom = Math.max(...flat.map((e) => e.y + e.height))
  return {
    nodes: flat,
    totalWidth: acc - H_GAP,
    totalHeight: maxBottom,
    maxDepth: colW.length - 1,
  }
}
