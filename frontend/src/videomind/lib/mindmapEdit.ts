import type { MindMapNode } from '../types'

/**
 * 导图树的本地编辑工具。
 *
 * 为什么前端也要一套：用户点「+」之后界面必须**立刻**出现新节点，
 * 等后端往返再刷新会让人以为没点到。后端在保存时还会再做一次同样的
 * 校验（限深限宽、时间戳夹取），所以这里只负责「看起来对」，不做信任判断。
 */

// 与后端 pipeline/mindmap.py 的 MAX_DEPTH 保持一致：
// 两边不一致会出现「前端点得动，后端保存时被悄悄截断」。
const MAX_DEPTH = 8
const MAX_CHILDREN = 7

/**
 * 笔记节点的类型标记，与后端 pipeline/mindmap.py 的 NOTE_KIND 一致。
 *
 * 笔记节点不挂时间轴：没有 start / end，不参与兄弟排序、区间瓜分和
 * 父节点派生（父节点的时间范围不会因为它而改变）。笔记下面的子节点
 * 自动也是笔记——一支注记整体不对应视频里的某一段。
 */
export const NOTE_KIND = 'note' as const

export function isNote(node: MindMapNode | null | undefined): boolean {
  return node?.kind === NOTE_KIND
}

export function cloneTree(tree: MindMapNode): MindMapNode {
  return JSON.parse(JSON.stringify(tree)) as MindMapNode
}

export function findNode(tree: MindMapNode, id: string): MindMapNode | null {
  if (tree.id === id) return tree
  for (const c of tree.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

export function nodeDepth(tree: MindMapNode, id: string, depth = 0): number | null {
  if (tree.id === id) return depth
  for (const c of tree.children ?? []) {
    const d = nodeDepth(c, id, depth + 1)
    if (d !== null) return d
  }
  return null
}

/**
 * 返回一棵改过之后的新树（不改原树），并告知是否真的命中了节点。
 *
 * start / end 一起传时才一起改；只传一个就只动那一个——
 * 「只把终点往后挪、不动起点」是最常见的微调，必须表达得出来。
 */
export function updateNode(
  tree: MindMapNode,
  id: string,
  patch: Partial<Pick<MindMapNode, 'label' | 'start' | 'end' | 'scale' | 'pinned' | 'kind'>>,
): { tree: MindMapNode; hit: boolean } {
  const next = cloneTree(tree)
  const node = findNode(next, id)
  if (!node) return { tree, hit: false }
  if (patch.label !== undefined) node.label = patch.label
  if (patch.start !== undefined) node.start = patch.start
  if (patch.end !== undefined) node.end = patch.end
  if (patch.scale !== undefined) node.scale = patch.scale
  if (patch.pinned !== undefined) node.pinned = patch.pinned
  if (patch.kind !== undefined) {
    if (patch.kind === NOTE_KIND) {
      node.kind = NOTE_KIND
      // 笔记不挂时间轴：转成笔记的同时把时间清掉，否则界面上会出现
      // 「写着笔记、旁边却挂着一个时间范围」这种自相矛盾的节点
      node.start = null
      node.end = null
      node.pinned = null
      stripNoteTimes(node)
    } else {
      delete node.kind
    }
  }

  // 收尾统一查一次合法性：没有起点却挂着终点、或终点早于起点，
  // 显示出来就是「15:00–12:30」这种倒挂范围，直接把终点清掉。
  // 后端保存时也会再查一遍，这里是让界面立刻看起来是对的。
  if (node.start === null || node.start === undefined) {
    node.end = null
  } else if (node.end != null && node.end <= node.start) {
    node.end = null
  }
  return { tree: next, hit: true }
}

/** 笔记分支整支退出时间轴：节点及其所有后代都不保留时间 */
function stripNoteTimes(node: MindMapNode): void {
  node.kind = NOTE_KIND
  node.start = null
  node.end = null
  node.pinned = null
  for (const kid of node.children ?? []) stripNoteTimes(kid)
}

export function addChildNode(
  tree: MindMapNode,
  parentId: string,
  kind?: 'note',
): { tree: MindMapNode; id: string | null; reason?: string } {
  const next = cloneTree(tree)
  const parent = findNode(next, parentId)
  if (!parent) return { tree, id: null, reason: '父节点不存在' }

  const depth = nodeDepth(next, parentId) ?? 0
  if (depth + 1 > MAX_DEPTH) {
    return { tree, id: null, reason: `导图最多 ${MAX_DEPTH + 1} 层，这一层不能再加子节点` }
  }
  const kids = parent.children ?? []
  if (kids.length >= MAX_CHILDREN) {
    return { tree, id: null, reason: `单个节点最多挂 ${MAX_CHILDREN} 个子节点` }
  }

  const id = `new-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`
  // 笔记下面再加的节点自动也是笔记：一支注记整体不挂时间轴
  const note = kind === NOTE_KIND || isNote(parent)
  parent.children = [
    ...kids,
    note
      ? { id, label: '新笔记', start: null, scale: 1, kind: NOTE_KIND }
      : { id, label: '新节点', start: null, scale: 1 },
  ]
  return { tree: next, id }
}

export function parentIdOf(tree: MindMapNode, id: string): string | null {
  for (const c of tree.children ?? []) {
    if (c.id === id) return tree.id ?? null
    const hit = parentIdOf(c, id)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 在指定节点**后面**插入一个同级节点。
 *
 * 键盘流里 Enter 就是这个语义（XMind 同款），没有它用户只能靠鼠标点父节点再点「+子」，
 * 连续录入五六个要点时手感差别非常大。
 */
export function addSiblingNode(
  tree: MindMapNode,
  siblingId: string,
  kind?: 'note',
): { tree: MindMapNode; id: string | null; reason?: string } {
  if (tree.id === siblingId) {
    return { tree, id: null, reason: '根节点没有同级节点' }
  }

  const next = cloneTree(tree)
  const id = `new-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`

  function walk(node: MindMapNode): boolean {
    const kids = node.children ?? []
    const idx = kids.findIndex((k) => k.id === siblingId)
    if (idx >= 0) {
      if (kids.length >= MAX_CHILDREN) {
        throw new Error(`单个节点最多挂 ${MAX_CHILDREN} 个子节点`)
      }
      // 与兄弟同属一支：父节点是笔记时，新兄弟也是笔记
      const note = kind === NOTE_KIND || isNote(node)
      const fresh: MindMapNode = note
        ? { id, label: '新笔记', start: null, scale: 1, kind: NOTE_KIND }
        : { id, label: '新节点', start: null, scale: 1 }
      node.children = [...kids.slice(0, idx + 1), fresh, ...kids.slice(idx + 1)]
      return true
    }
    for (const k of kids) {
      if (walk(k)) return true
    }
    return false
  }

  try {
    if (!walk(next)) return { tree, id: null, reason: '目标节点不存在' }
  } catch (e) {
    return { tree, id: null, reason: (e as Error).message }
  }
  return { tree: next, id }
}

export function removeNodeById(
  tree: MindMapNode,
  id: string,
): { tree: MindMapNode; removed: boolean } {
  if (tree.id === id) return { tree, removed: false } // 根节点不可删

  const next = cloneTree(tree)

  function walk(node: MindMapNode): boolean {
    const kids = node.children ?? []
    const idx = kids.findIndex((k) => k.id === id)
    if (idx >= 0) {
      node.children = kids.filter((_, i) => i !== idx)
      return true
    }
    for (const k of kids) {
      if (walk(k)) return true
    }
    return false
  }

  return { tree: next, removed: walk(next) }
}

/**
 * 解析用户输入的時間：支持 `90`、`1:30`、`01:02:03` 三种写法。
 *
 * 为什么必须宽容：节点时间戳是「边看边标」的产物，让人为了填个时间
 * 先心算成秒数，等同于劝退。填错就返回 null，由调用方提示。
 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null

  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.max(0, Number(text))
  }
  const parts = text.split(':')
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null
  const nums = parts.map((p) => Number(p.trim()))
  if (nums.length === 2) return nums[0] * 60 + nums[1]
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
  return null
}

/** 缩放步长；与后端 MIN_SCALE/MAX_SCALE 保持一致 */
export const SCALE_STEP = 0.2
export const SCALE_MIN = 0.8
export const SCALE_MAX = 2.0

/** 把任意值夹到合法缩放区间。鼠标拖拽缩放手柄时每帧都要调，所以单独抽出来 */
export function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(v * 100) / 100))
}

export function nextScale(current: number | null | undefined, delta: number): number {
  const base = typeof current === 'number' && current > 0 ? current : 1
  return clampScale(base + delta)
}
