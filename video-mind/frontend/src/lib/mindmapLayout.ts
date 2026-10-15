import type { MindMapNode } from '../types'

/**
 * 把后端返回的导图树摆成「从左到右」的层次布局。
 *
 * 为什么自己写而不引 dagre / elkjs：
 *   思维导图的布局规则其实很固定——列按深度、行按叶子顺序——
 *   40 行代码就能得到干净且可预测的结果，还能按中文字宽自适应节点宽度。
 *   引一个几十 KB 的通用图布局引擎来做这件事属于杀鸡用牛刀。
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
}

export interface LayoutResult {
  nodes: LaidOutNode[]
  totalWidth: number
  totalHeight: number
  maxDepth: number
}

/** 中文字符按 1 个字宽、西文按 0.55 估算，避免节点文字被截断或留大片空白。 */
function estimateWidth(label: string): number {
  let w = 0
  for (const ch of label) {
    w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55
  }
  return Math.max(MIN_W, Math.min(MAX_W, w * CHAR_W + PAD_X))
}

export function layoutMindMap(tree: MindMapNode): LayoutResult {
  const flat: LaidOutNode[] = []
  let seq = 0

  // 第一遍：展开成扁平数组，顺带算出每个节点的宽度与深度
  function collect(node: MindMapNode, depth: number, parentId: string | null): string {
    const id = `n${seq++}`
    const entry: LaidOutNode = {
      id,
      label: node.label,
      start: node.start ?? null,
      depth,
      x: 0,
      y: 0,
      width: estimateWidth(node.label),
      height: NODE_H,
      parentId,
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
      cursorY += NODE_H + V_GAP
    } else {
      const ys = kids.map(assignY)
      e.y = (ys[0] + ys[ys.length - 1]) / 2
    }
    return e.y
  }
  assignY(flat[0].id)

  for (const e of flat) {
    e.x = colX[e.depth]
  }

  return {
    nodes: flat,
    totalWidth: acc - H_GAP,
    totalHeight: Math.max(cursorY - V_GAP, NODE_H),
    maxDepth: colW.length - 1,
  }
}
