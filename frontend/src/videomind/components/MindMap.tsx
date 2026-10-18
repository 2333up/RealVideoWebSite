import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MindMapNode } from '../types'
import {
  layoutMindMap,
  type EditingTarget,
  type LayoutResult,
  type MindTool,
  type MindViewActions,
} from '../lib/mindmapLayout'
import {
  addChildNode,
  addSiblingNode,
  clampScale,
  findNode,
  isNote,
  nextScale,
  removeNodeById,
  updateNode,
} from '../lib/mindmapEdit'
import { api } from '../api'
import MindMapCanvas from './MindMapCanvas'
import MindOutline from './MindOutline'
import NodeNote from './NodeNote'
import MindNodeToolBar from './MindNodeToolBar'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  FoldAllIcon,
  FullscreenIcon,
  IconButton,
  KeyboardIcon,
  MemoIcon,
  MIN_TAPPABLE,
  UnfoldAllIcon,
} from './icons'

type ViewMode = 'map' | 'outline'

interface Props {
  tree: MindMapNode
  /** 折叠状态按视频分别存，切视频时不该串台 */
  videoId: number
  currentTime: number
  onSeek: (t: number) => void
  /** 保存整棵树；由 App 负责调接口并刷新详情（章节会跟着变） */
  onSaveTree: (tree: MindMapNode) => Promise<void>
}

export default function MindMap({ tree, videoId, currentTime, onSeek, onSaveTree }: Props) {
  const [view, setView] = useState<ViewMode>('map')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(videoId))
  // 手动拖拽产生的节点偏移。和折叠一样属于视图状态，不进树、不触发保存。
  const [offsets, setOffsets] = useState<Map<string, NodeOffset>>(() => loadOffsets(videoId))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingTarget>(null)
  const [query, setQuery] = useState('')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [revealTick, setRevealTick] = useState(0)
  const [saving, setSaving] = useState(false)
  /**
   * 编辑模式开关。默认关闭：导图是「看」的东西比「改」的时候多得多，
   * 常开的话一次误触双击就把节点改成了输入框内容。
   * 偏好跨视频保留（用户调一次就一直生效），所以不和 videoId 绑定。
   */
  const [editable, setEditable] = useState<boolean>(() => loadEditMode())
  /**
   * 左键拖画布的含义。
   *
   * **默认平移**（2026-10-18 用户要求）：导图比画布大得多，进来第一件事
   * 往往是「挪一下看看」，而不是框选。框选是低频操作，需要时点一下工具条的
   * 那个切换按钮即可（它显示的是当前模式）。
   * 这个选择与「只读 / 编辑中」无关，切换模式不会把它重置掉。
   */
  const [tool, setTool] = useState<MindTool>('pan')
  /** 大纲里是否铺出每个节点的 1-2 句摘要。默认开——大纲的价值就在「不用点开也读得懂」 */
  const [showSummary, setShowSummary] = useState(true)
  /** 框选/点选得到的节点集合；多选后拖任意一个，整组一起移动 */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  /**
   * 拖动节点右下角手柄时的临时缩放（只活在内存里）。
   *
   * 直接喂给布局计算，而不是用 CSS 临时放大：这样连线、与邻居的间距、
   * 列宽都跟着变，松手时画面不会突然跳一下。松手后才写树并保存。
   */
  const [liveScale, setLiveScale] = useState<Map<string, number>>(new Map())
  /**
   * 节点笔记（Markdown）。
   *
   * 保存走独立接口，不回灌整棵树——否则每写两行就要重新拉一次视频详情
   * （转写稿 2800 多段，白烧一次渲染）。这里只把改动记在本地覆盖表里，
   * 布局与「有没有笔记」的小图标都读它；真值早就在后端存好了。
   */
  const [notes, setNotes] = useState<Map<string, string>>(new Map())
  /** 笔记面板开着没 */
  const [noteOpen, setNoteOpen] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  /** 最近一次收到的选中集合签名，用来挡掉 ReactFlow 的回环回调 */
  const selectionSigRef = useRef('')

  // 切视频时重新载入折叠状态，并把搜索/聚焦/选中这些临时态清掉——
  // 上一支视频留下的「聚焦某分支」会让新视频看起来只剩一条分支，像是坏了。
  useEffect(() => {
    setCollapsed(loadCollapsed(videoId))
    setOffsets(loadOffsets(videoId))
    setSelectedId(null)
    setEditing(null)
    setQuery('')
    setFocusId(null)
    setMenu(null)
    setSelection(new Set())
    setLiveScale(new Map())
    setNotes(new Map())
    setNoteOpen(false)
  }, [videoId])

  useEffect(() => {
    saveEditMode(editable)
  }, [editable])

  /**
   * 切换模式时清空选择。
   *
   * 编辑模式没有框选，留着上一组选中的八个节点只会让画面上一片描边环，
   * 而按 Delete 删的却只是其中一个——看到的和做得到的对不上。
   *
   * 注意这里**不再顺手改「左键拖」的含义**：平移已经是默认值，工具是用户
   * 自己点出来的选择，切个模式就把它重置掉只会让人反复重设。
   */
  const toggleEditable = useCallback(() => {
    setEditable((v) => !v)
    selectionSigRef.current = ''
    setSelection(new Set())
    setEditing(null)
    // 退出编辑模式时把「拖到一半的尺寸预览」丢掉：留着它，画面上的节点
    // 会是一个从来没被保存过的大小，看起来像保存失败了
    setLiveScale(new Map())
  }, [])

  useEffect(() => {
    saveCollapsed(videoId, collapsed)
  }, [videoId, collapsed])

  useEffect(() => {
    saveOffsets(videoId, offsets)
  }, [videoId, offsets])

  // ---------------------------------------------------------------- 树索引
  // id 生成规则必须与 layoutMindMap 完全一致（缺失时按 DFS 顺序补 n0/n1…），
  // 否则这里算出来的父指针指向的节点在布局里根本不存在。
  const index = useMemo(() => {
    const parentOf = new Map<string, string | null>()
    const childrenOf = new Map<string, string[]>()
    const withKids = new Set<string>()
    // 有**非笔记**子节点的节点：只有这些节点的时间才是「由子节点算出来的」。
    // 子节点全是笔记时，节点自己的时间仍归自己管（后端 derive_parent_ranges 同样保留）
    const timedParent = new Set<string>()
    const noteIds = new Set<string>()
    const dfs: { id: string; label: string; depth: number; note: boolean }[] = []
    let seq = 0
    function walk(node: MindMapNode, depth: number, parent: string | null): string {
      const id = node.id || `n${seq}`
      seq += 1
      const note = isNote(node)
      parentOf.set(id, parent)
      if (note) noteIds.add(id)
      dfs.push({ id, label: node.label, depth, note })
      const kids = node.children ?? []
      if (kids.length) withKids.add(id)
      if (kids.some((k) => k.kind !== 'note')) timedParent.add(id)
      if (parent) {
        const arr = childrenOf.get(parent) ?? []
        arr.push(id)
        childrenOf.set(parent, arr)
      }
      for (const c of kids) walk(c, depth + 1, id)
      return id
    }
    walk(tree, 0, null)
    return { parentOf, childrenOf, withKids, timedParent, noteIds, dfs, rootId: dfs[0]?.id ?? '' }
  }, [tree])

  const q = query.trim().toLowerCase()

  const matches = useMemo(() => {
    const s = new Set<string>()
    if (!q) return s
    for (const it of index.dfs) {
      if (it.label.toLowerCase().includes(q)) s.add(it.id)
    }
    return s
  }, [index, q])

  // 命中的节点若藏在折叠分支里，等于搜到了却看不见。
  // 搜索期间把所有命中项的祖先链强制展开，保证「搜到就能看到」。
  const forceExpand = useMemo(() => {
    const s = new Set<string>()
    if (!q) return s
    for (const id of matches) {
      let cur = index.parentOf.get(id) ?? null
      while (cur) {
        s.add(cur)
        cur = index.parentOf.get(cur) ?? null
      }
    }
    return s
  }, [matches, index, q])

  const matchList = useMemo(
    () => index.dfs.filter((it) => matches.has(it.id)).map((it) => it.id),
    [index, matches],
  )

  /** 把本地笔记覆盖表合进树（只在有未回灌的改动时才拷贝） */
  const applyNotes = useCallback(
    (src: MindMapNode): MindMapNode => {
      if (notes.size === 0) return src
      const out = JSON.parse(JSON.stringify(src)) as MindMapNode
      const walk = (n: MindMapNode) => {
        if (n.id && notes.has(n.id)) {
          const text = notes.get(n.id) as string
          if (text.trim()) n.note = text
          else delete n.note
        }
        for (const k of n.children ?? []) walk(k)
      }
      walk(out)
      return out
    },
    [notes],
  )

  /** 布局用的树：带上笔记，节点上才能显示出「有笔记」的小图标 */
  const treeForLayout = useMemo(() => applyNotes(tree), [applyNotes, tree])

  const layout: LayoutResult = useMemo(
    () =>
      layoutMindMap(treeForLayout, {
        collapsed,
        focusId,
        forceExpand,
        offsets,
        scaleOverride: liveScale,
      }),
    [treeForLayout, collapsed, focusId, forceExpand, offsets, liveScale],
  )

  // 计算「当前所处节点」：取所有 start <= currentTime 中 start 最大的那个。
  // 这比「判断落在区间内」更稳——节点时间戳是稀疏的，区间判断会频繁落空。
  const activeId = useMemo(() => {
    let bestId: string | null = null
    let bestStart = -Infinity
    let seq = 0
    const walk = (node: MindMapNode) => {
      const id = node.id || `n${seq}`
      seq += 1
      const s = node.start
      if (s !== null && s !== undefined && s <= currentTime && s > bestStart) {
        bestId = id
        bestStart = s
      }
      ;(node.children ?? []).forEach((c) => walk(c))
    }
    walk(tree)
    return bestId
  }, [tree, currentTime])

  // ---------------------------------------------------------------- 写操作

  const commit = useCallback(
    async (next: MindMapNode) => {
      setSaving(true)
      try {
        // 整树保存必须把笔记一起带上：本地这份 tree 是「保存笔记之前」的快照，
        // 直接发过去会把刚写好的笔记覆盖掉（后端是整树替换）。
        await onSaveTree(applyNotes(next))
      } finally {
        setSaving(false)
      }
    },
    [onSaveTree, applyNotes],
  )

  /**
   * 保存单个节点的 Markdown 笔记。
   *
   * 走独立接口：整树 PATCH 会重跑时间整理、还会同步章节边界，
   * 而写两行字不该让任何时间戳或章节动一下。
   */
  const saveNote = useCallback(
    async (id: string, text: string) => {
      const res = await api.saveNodeNote(videoId, id, text)
      setNotes((prev) => {
        const next = new Map(prev)
        next.set(id, res.note)
        return next
      })
    },
    [videoId],
  )

  /** 某个节点当前的笔记：本地覆盖优先，其次树里存的 */
  const noteOf = useCallback(
    (id: string | null): string => {
      if (!id) return ''
      if (notes.has(id)) return notes.get(id) as string
      return findNode(tree, id)?.note ?? ''
    },
    [notes, tree],
  )

  /**
   * 写操作统一在源头卡一道：只要不在编辑模式就直接吞掉。
   *
   * 不只在 UI 层置灰——键盘、右键菜单、工具条、快捷键面板是四条独立入口，
   * 任一处漏判都会变成「说好了只读，结果还是改掉了」。源头拦截才是兜得住的那个。
   */
  const actions: MindViewActions = useMemo(
    () => ({
      seek: onSeek,
      select: (id) => setSelectedId(id),
      beginEdit: (id, field) => {
        if (!editable) return
        // 有子节点的节点，时间范围是子节点算出来的，不给编辑入口；
        // 笔记节点根本不在时间轴上，也没有时间可填。
        // 这里再拦一道（不只置灰按钮）：右键菜单、工具条、时间徽章是三条独立入口，
        // 任一处漏判都会变成「说好了只读，结果还是改掉了」。
        if (field === 'time' && (index.timedParent.has(id) || index.noteIds.has(id))) return
        setSelectedId(id)
        setEditing({ id, field })
      },
      cancelEdit: () => setEditing(null),
      commitLabel: (id, label) => {
        if (!editable || !label) return
        const { tree: next } = updateNode(tree, id, { label })
        void commit(next)
      },
      commitRange: (id, start, end) => {
        if (!editable) return
        // 父节点的时间由子节点决定，写进来也只会在后端被覆盖——干脆不写；
        // 笔记节点没有时间轴，写了也会被后端清掉
        if (index.timedParent.has(id) || index.noteIds.has(id)) return
        // pinned 记录「用户显式设过时间」：后端只为这类节点生成章节，
        // 免得改一次文案就冒出一堆继承时间戳的重复章节。
        const { tree: next } = updateNode(tree, id, {
          start,
          end,
          pinned: start !== null,
        })
        void commit(next)
        // 立刻跳过去：设时间戳的人下一步就是「看看这个位置对不对」
        if (start !== null) onSeek(start)
      },
      addChild: (id) => {
        if (!editable) return
        const { tree: next, id: newId, reason } = addChildNode(tree, id)
        if (!newId) {
          if (reason) alert(reason)
          return
        }
        void commit(next)
        setSelectedId(newId)
        setEditing({ id: newId, field: 'label' })
        // 父节点若处于折叠态，新节点会「加了却看不见」，先展开
        setCollapsed((prev) => {
          if (!prev.has(id)) return prev
          const nextSet = new Set(prev)
          nextSet.delete(id)
          return nextSet
        })
      },
      addSibling: (id) => {
        if (!editable) return
        const { tree: next, id: newId, reason } = addSiblingNode(tree, id)
        if (!newId) {
          if (reason) alert(reason)
          return
        }
        void commit(next)
        setSelectedId(newId)
        setEditing({ id: newId, field: 'label' })
      },
      addNote: (id) => {
        if (!editable) return
        const { tree: next, id: newId, reason } = addChildNode(tree, id, 'note')
        if (!newId) {
          if (reason) alert(reason)
          return
        }
        void commit(next)
        setSelectedId(newId)
        setEditing({ id: newId, field: 'label' })
        // 父节点折叠着的话，新笔记会「加了却看不见」，先展开
        setCollapsed((prev) => {
          if (!prev.has(id)) return prev
          const nextSet = new Set(prev)
          nextSet.delete(id)
          return nextSet
        })
      },
      remove: (id) => {
        if (!editable) return
        if (id === index.rootId) {
          alert('根节点不能删除')
          return
        }
        if (!confirm('删除该节点及其所有子节点？由它们生成的章节也会一并删除。')) return
        const { tree: next } = removeNodeById(tree, id)
        void commit(next)
        setSelectedId(null)
        setSelection((prev) => {
          if (!prev.has(id)) return prev
          const s = new Set(prev)
          s.delete(id)
          return s
        })
      },
      rescale: (id, delta) => {
        if (!editable) return
        const current = findNode(tree, id)?.scale
        const { tree: next } = updateNode(tree, id, { scale: nextScale(current, delta) })
        void commit(next)
      },
      previewScale: (id, scale) => {
        if (!editable) return
        setLiveScale((prev) => {
          const next = new Map(prev)
          if (scale === null) {
            if (!next.delete(id)) return prev
          } else {
            const v = clampScale(scale)
            if (next.get(id) === v) return prev
            next.set(id, v)
          }
          return next
        })
      },
      commitScale: (id, scale) => {
        if (!editable) return
        // 先清预览：树里的 scale 一落，布局用的就是同一份值，不必等保存往返
        setLiveScale((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        const current = findNode(tree, id)?.scale
        const v = clampScale(scale)
        if (typeof current === 'number' && Math.abs(current - v) < 0.005) return
        const { tree: next } = updateNode(tree, id, { scale: v })
        void commit(next)
      },
      openNote: (id) => {
        setSelectedId(id)
        setNoteOpen(true)
      },
      toggleCollapse: (id) =>
        setCollapsed((prev) => {
          const nextSet = new Set(prev)
          if (nextSet.has(id)) nextSet.delete(id)
          else nextSet.add(id)
          return nextSet
        }),
      collapseDeep: (id) =>
        setCollapsed((prev) => {
          const nextSet = new Set(prev)
          nextSet.add(id)
          // 连同所有后代一起标记折叠：展开时才能「一层一层」而不是一下全开
          const stack = [...(index.childrenOf.get(id) ?? [])]
          while (stack.length) {
            const cur = stack.pop() as string
            if (index.withKids.has(cur)) nextSet.add(cur)
            stack.push(...(index.childrenOf.get(cur) ?? []))
          }
          return nextSet
        }),
      focusBranch: (id) => {
        setFocusId((cur) => (cur === id ? null : id))
        setMenu(null)
      },
      openMenu: (id, x, y) => setMenu({ id, x, y }),
    }),
    // editable 必须在依赖里：里面的闸门读的就是它。
    // 漏了它的话，切换模式后 actions 闭包里仍是旧值，切到编辑模式也改不动任何东西
    [
      tree,
      commit,
      onSeek,
      index.rootId,
      index.childrenOf,
      index.withKids,
      index.timedParent,
      index.noteIds,
      editable,
    ],
  )

  // ---------------------------------------------------------------- 键盘流
  // XMind 之所以「快到飞起」，一半功劳在键盘：Enter 兄弟、Tab 子级、F2 改名、
  // 方向键游走。只靠鼠标点悬浮按钮，录十个要点要点二十次。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const wrap = wrapRef.current
      if (!wrap) return
      // 只在本面板内响应：否则在左侧视频列表里按 Delete 会把导图节点删掉
      const inside =
        wrap.contains(document.activeElement) || wrap.matches(':hover') || fullscreen
      if (!inside) return

      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing) return

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      const id = selectedId ?? index.rootId

      if (e.key === 'Escape') {
        if (menu) setMenu(null)
        else if (focusId) setFocusId(null)
        else if (query) setQuery('')
        else setSelectedId(null)
        return
      }

      // 以下折叠/导航在两种模式都可用：浏览时它们只是「换个看法」，不改内容
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault()
        actions.toggleCollapse(id)
        return
      }

      // 写操作一律只在编辑模式生效。Escape 单独放行，它是「退出」不是「修改」
      if (!editable) return

      if (e.key === 'Tab') {
        e.preventDefault()
        if (id) actions.addChild(id)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (id && id !== index.rootId) actions.addSibling(id)
        else if (id) actions.beginEdit(id, 'label')
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        if (id) actions.beginEdit(id, 'label')
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        if (id) actions.remove(id)
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const order = layout.order
        if (order.length === 0) return
        const cur = order.indexOf(id)
        const nextIdx =
          cur === -1 ? 0 : Math.max(0, Math.min(order.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
        setSelectedId(order[nextIdx])
        setRevealTick((v) => v + 1)
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        if (!id) return
        const hasKids = index.withKids.has(id)
        if (e.key === 'ArrowRight') {
          // 已折叠 → 先展开；已展开 → 跳到第一个子节点
          if (collapsed.has(id) && hasKids) actions.toggleCollapse(id)
          else {
            const kid = index.dfs.find((it) => index.parentOf.get(it.id) === id)
            if (kid) {
              setSelectedId(kid.id)
              setRevealTick((v) => v + 1)
            }
          }
        } else {
          if (!collapsed.has(id) && hasKids) actions.toggleCollapse(id)
          else {
            const parent = index.parentOf.get(id)
            if (parent) {
              setSelectedId(parent)
              setRevealTick((v) => v + 1)
            }
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions, collapsed, editable, focusId, index, layout.order, menu, query, selectedId, fullscreen])

  // ---------------------------------------------------------------- 派生 UI

  const matchIdx = selectedId ? matchList.indexOf(selectedId) : -1

  const jumpMatch = (delta: number) => {
    if (matchList.length === 0) return
    const base = matchIdx >= 0 ? matchIdx : -1
    const nextIdx = (base + delta + matchList.length) % matchList.length
    setSelectedId(matchList[nextIdx])
    setRevealTick((v) => v + 1)
  }

  /**
   * 「收起」= 折叠根节点，也就是真的只剩一个根。
   *
   * 之前的实现是「折叠到一级分支」，结果用户点完看到还有七个分支挂着，
   * 反馈是「收不起所有节点」。既然按钮叫「收起」，就该收到底——
   * 想看一级分支的话，展开后逐个收分支即可。
   */
  const collapseAll = () => {
    const next = new Set<string>()
    if (index.withKids.has(index.rootId)) next.add(index.rootId)
    setCollapsed(next)
  }

  const hasManualLayout = offsets.size > 0

  /**
   * 拖拽落点 → 相对自动布局位置的偏移。
   *
   * moved 是一次拖拽里被挪动的**所有**节点：多选时 ReactFlow 会带着整组一起走，
   * 所以这里必须逐个记账，只记被拖的那一个的话，其余节点松手瞬间会被弹回原位。
   * 存相对量（而不是绝对坐标）是因为折叠别的分支会改变自动布局的基准位置。
   */
  const handleDragStop = useCallback(
    (moved: { id: string; x: number; y: number }[]) => {
      setOffsets((prev) => {
        const next = new Map(prev)
        let changed = false
        for (const m of moved) {
          const b = layout.base.get(m.id)
          if (!b) continue
          const dx = Math.round(m.x - b.x)
          const dy = Math.round(m.y - b.y)
          if (dx === 0 && dy === 0) {
            if (next.delete(m.id)) changed = true
            continue
          }
          const old = next.get(m.id)
          if (old && old.dx === dx && old.dy === dy) continue
          next.set(m.id, { dx, dy })
          changed = true
        }
        return changed ? next : prev
      })
    },
    [layout],
  )

  /**
   * 框选/点选结果同步进来，并把「键盘与右键的操作目标」落在选中集合的第一个上。
   *
   * 必须先比对签名再落地：这份选中态会被写回 nodes 的 selected 字段，
   * 而 ReactFlow 每次收到新 nodes 都可能再抛一次 selection change，
   * 无脑 setState 就变成「改状态 → 重渲染 → 又来一次」的自激循环。
   */
  const handleSelectionChange = useCallback((ids: string[]) => {
    const sig = ids.slice().sort().join('|')
    if (sig === selectionSigRef.current) return
    selectionSigRef.current = sig
    setSelection(new Set(ids))
    setSelectedId(ids[0] ?? null)
  }, [])

  /** 顶部操作条要显示的当前作用对象 */
  /**
   * 每个节点「点了会跳到哪里」。
   *
   * 分类节点自身不存时间戳——它的时间就是第一个子节点的时间，存一份只会
   * 在大纲里显示成上下两行重复的时间，还会让章节区间交叉。
   * 所以点击分类节点时要向下找到第一个真正有时间的后代；叶子用自己的时间。
   *
   * 笔记节点（kind="note"）直接映射成 null：它不在时间轴上，点它什么都不该发生，
   * 也不能被父节点当成「第一个有时间的后代」——那会让「点分支跳到笔记位置」成立。
   */
  const seekTimeOf = useMemo(() => {
    const out = new Map<string, number | null>()
    const walk = (node: MindMapNode): number | null => {
      if (isNote(node)) {
        if (node.id) out.set(node.id, null)
        return null
      }
      const own = typeof node.start === 'number' ? node.start : null
      let first: number | null = null
      for (const kid of node.children ?? []) {
        const t = walk(kid)
        if (t !== null && first === null) first = t
      }
      const value = own ?? first
      if (node.id) out.set(node.id, value)
      return value
    }
    walk(tree)
    return out
  }, [tree])

  const toolbarNode = useMemo(() => {
    if (!selectedId) return null
    const n = layout.nodes.find((x) => x.id === selectedId)
    if (!n) return null
    return {
      id: n.id,
      label: n.label,
      color: n.color,
      hasChildren: n.hasChildren,
      timedChildren: n.timedChildren,
      collapsed: n.collapsed,
      note: n.note,
    }
  }, [selectedId, layout])

  /**
   * 包装操作条上的每个按钮。
   *
   * 除了「没有选中节点就什么都不做」，还要先把目标节点带进视口：
   * 操作条固定在顶部，选中的节点可能远在画布视野之外，
   * 点了「改名」却看不到输入框出现在哪，会让人以为按钮坏了。
   */
  const actOnSelected = (fn: (id: string) => void) => () => {
    if (!selectedId) return
    if (view === 'map') setRevealTick((v) => v + 1)
    fn(selectedId)
  }

  const focusLabel = useMemo(() => {
    if (!focusId) return ''
    const hit = index.dfs.find((it) => it.id === focusId)
    return hit ? hit.label : ''
  }, [focusId, index])

  const menuNode = menu ? index.dfs.find((it) => it.id === menu.id) : null

  const inner = (
    <div className="flex flex-col min-h-0 w-full h-full">
      {/* 工具条：压成一行。右栏本来就只有 460px 宽，三行工具条
          （开关行 + 搜索行 + 提示行）要吃掉 130px 高度——图都看不了几行。
          提示行整行删掉：模式状态看「只读/编辑中」按钮就知道，
          「已选 n 个」挪到底部状态行，「框选/平移」收进这一行的图标切换。 */}
      <div className="shrink-0 border-b border-gray-100 px-2 py-1.5">
        <div className="flex items-center gap-1">
          {/* 编辑模式开关：默认只读，看图时随手误触不该改到内容 */}
          <button
            onClick={toggleEditable}
            title={
              editable
                ? '退出编辑模式：此后只能浏览、框选和移动节点，改不了内容'
                : '进入编辑模式：可改名、增删节点、改时间戳'
            }
            className={[
              'shrink-0 text-[10px] px-1.5 rounded border transition',
              editable
                ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-500'
                : 'border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
              MIN_TAPPABLE,
            ].join(' ')}
          >
            {editable ? '编辑中' : '只读'}
          </button>

          <div className="flex rounded border border-gray-200 overflow-hidden">
            {(
              [
                ['map', '导图'],
                ['outline', '大纲'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={[
                  'px-2 text-[11px] transition',
                  view === key
                    ? 'bg-slate-800 text-white'
                    : 'bg-white text-gray-500 hover:text-gray-900 hover:bg-gray-50',
                  MIN_TAPPABLE,
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 全部收起 / 全部展开：文字按钮改图标，一行才塞得下其余工具 */}
          <IconButton
            icon={<FoldAllIcon size={15} />}
            label="全部收起，只剩根节点"
            onClick={collapseAll}
            className="border border-gray-200 hover:bg-gray-50 hover:text-gray-900"
          />
          <IconButton
            icon={<UnfoldAllIcon size={15} />}
            label="展开所有分支"
            onClick={() => setCollapsed(new Set())}
            className="border border-gray-200 hover:bg-gray-50 hover:text-gray-900"
          />

          {/* 左键拖画布的含义（框选/平移），一个按钮来回切，不再独占一行 */}
          <button
            onClick={() => setTool((t) => (t === 'select' ? 'pan' : 'select'))}
            title={
              tool === 'select'
                ? '当前：左键拖空白 = 框选节点。点我切成平移（空格拖始终可临时平移）'
                : '当前：左键拖空白 = 平移画布。点我切成框选'
            }
            className={[
              'shrink-0 text-[10px] px-1.5 rounded border transition',
              'bg-white text-gray-500 hover:text-gray-900 hover:bg-gray-50',
              MIN_TAPPABLE,
            ].join(' ')}
          >
            {tool === 'select' ? '框选' : '平移'}
          </button>

          {/* 笔记面板开关：把「选中节点的 Markdown 笔记」摊在导图下方。
              图标按钮——右栏这一行已经很挤，搜索框还要留活路。 */}
          <IconButton
            icon={<MemoIcon size={15} />}
            label={noteOpen ? '收起笔记面板' : '查看 / 编辑选中节点的 Markdown 笔记'}
            onClick={() => setNoteOpen((v) => !v)}
            data-role="toggle-note"
            className={[
              'border transition',
              noteOpen
                ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                : 'border-gray-200 hover:bg-gray-50 hover:text-gray-900',
            ].join(' ')}
          />

          {/* 摘要开关只在大纲视图有意义：画布上摘要走悬浮提示 */}
          {view === 'outline' && (
            <button
              onClick={() => setShowSummary((v) => !v)}
              title={
                showSummary
                  ? '隐藏每个节点下的 1-2 句摘要，只看层级'
                  : '把每个节点下的 1-2 句摘要铺出来'
              }
              className={[
                'shrink-0 text-[10px] px-1.5 rounded border transition',
                showSummary
                  ? 'bg-slate-800 border-slate-800 text-white hover:bg-slate-700'
                  : 'border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                MIN_TAPPABLE,
              ].join(' ')}
            >
              摘要
            </button>
          )}
          {hasManualLayout && (
            <TBtn onClick={() => setOffsets(new Map())} title="清除手动拖拽的位置，恢复自动布局">
              整理
            </TBtn>
          )}

          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                jumpMatch(e.shiftKey ? -1 : 1)
              }
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="搜索节点…"
            // 和两侧的图标按钮同高：输入框原来是 py-1 + 11px 文本 = 25.9px，
            // 比按钮高出近 2px，这一排看上去「输入框比按钮胖一圈」
            className="flex-1 min-w-[72px] h-6 text-[11px] px-2 rounded border border-gray-200 focus:outline-none focus:border-blue-400"
          />
          {q && (
            <>
              <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                {matchList.length === 0 ? '无匹配' : `${matchIdx + 1}/${matchList.length}`}
              </span>
              {/* 上下箭头改成图标按钮：字符 ↑ ↓ 的字形在部分字体里
                  只占半角宽，button 实测 13×22，既窄又矮 */}
              <IconButton
                icon={<ArrowUpIcon size={14} />}
                label="上一个匹配"
                onClick={() => jumpMatch(-1)}
                className="border border-gray-200 hover:bg-gray-50 hover:text-gray-900"
              />
              <IconButton
                icon={<ArrowDownIcon size={14} />}
                label="下一个匹配"
                onClick={() => jumpMatch(1)}
                className="border border-gray-200 hover:bg-gray-50 hover:text-gray-900"
              />
            </>
          )}
          <IconButton
            icon={<KeyboardIcon size={15} />}
            label="操作说明"
            onClick={() => setShowShortcuts(true)}
            className="border border-gray-200 hover:bg-gray-50 hover:text-gray-900"
          />
          <IconButton
            icon={<FullscreenIcon size={15} />}
            label={fullscreen ? '退出全屏' : '全屏查看导图'}
            onClick={() => setFullscreen((f) => !f)}
            className="border border-gray-200 hover:bg-gray-50 hover:text-gray-900"
          />
        </div>

        {(focusId || saving) && (
          <div className="flex items-center gap-1.5 text-[10px] pt-1">
            {focusId && (
              <button
                onClick={() => setFocusId(null)}
                title="退出聚焦，显示全部"
                className={`items-center gap-1 max-w-[70%] px-1.5 rounded bg-amber-50 border border-amber-200 text-amber-800 hover:bg-amber-100 ${MIN_TAPPABLE}`}
              >
                <span className="truncate">聚焦：{focusLabel}</span>
                <CloseIcon size={12} />
              </button>
            )}
            {saving && <span className="text-gray-400">保存中…</span>}
          </div>
        )}
      </div>

      {/*
        固定的节点操作条：位置恒定在画布上方，不跟着节点跑，也就不会被相邻节点盖住。
        只在「编辑模式 + 已选中节点」时出现——右栏高度宝贵，一条永远置灰的
        工具条挂在那里纯属浪费；要用的时候它才出现。
      */}
      {editable && toolbarNode && (
        <MindNodeToolBar
          node={toolbarNode}
          editable={editable}
          onRename={actOnSelected((id) => actions.beginEdit(id, 'label'))}
          onAddChild={actOnSelected(actions.addChild)}
          onAddSibling={actOnSelected(actions.addSibling)}
          onAddNote={actOnSelected(actions.addNote)}
          onEditTime={actOnSelected((id) => actions.beginEdit(id, 'time'))}
          onToggleCollapse={actOnSelected(actions.toggleCollapse)}
          onRemove={actOnSelected(actions.remove)}
        />
      )}

      {/* 主体 */}
      <div className="relative flex-1 min-h-0 p-1.5">
        {layout.nodes.length === 0 ? (
          <div className="text-xs text-gray-400 text-center py-8">没有可见节点</div>
        ) : view === 'map' ? (
          <MindMapCanvas
            videoId={videoId}
            layout={layout}
            focusId={focusId}
            selectedId={selectedId}
            activeId={activeId}
            matches={matches}
            query={query}
            currentTime={currentTime}
            editing={editing}
            actions={actions}
            editable={editable}
            tool={tool}
            seekTimeOf={seekTimeOf}
            selection={selection}
            revealTick={revealTick}
            onDragStop={handleDragStop}
            onSelectionChange={handleSelectionChange}
          />
        ) : (
          <MindOutline
            layout={layout}
            selectedId={selectedId}
            activeId={activeId}
            matches={matches}
            query={query}
            currentTime={currentTime}
            editing={editing}
            editable={editable}
            seekTimeOf={seekTimeOf}
            showSummary={showSummary}
            actions={actions}
          />
        )}

      </div>

      {/* 笔记面板：摊在导图下方，不挤占画布宽度 */}
      {noteOpen &&
        (selectedId ? (
          <NodeNote
            key={selectedId}
            nodeId={selectedId}
            label={toolbarNode?.label ?? ''}
            note={noteOf(selectedId)}
            editable={editable}
            onSave={saveNote}
            onClose={() => setNoteOpen(false)}
          />
        ) : (
          <div className="shrink-0 flex items-center gap-2 border-t border-gray-200 bg-gray-50/70 px-2.5 py-2">
            <MemoIcon size={13} className="text-gray-400" />
            <span className="text-[11px] text-gray-500 flex-1">
              先在导图上点一个节点，这里会显示它的笔记
            </span>
            <button
              onClick={() => setNoteOpen(false)}
              aria-label="收起笔记面板"
              title="收起笔记面板"
              className="inline-flex items-center justify-center h-6 w-6 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200"
            >
              <CloseIcon size={13} />
            </button>
          </div>
        ))}

      <div className="shrink-0 px-2 py-1 border-t border-gray-100 text-[10px] text-gray-400 flex items-center gap-2">
        <span className="tabular-nums shrink-0">
          {layout.visibleCount} 个节点
          {layout.hiddenCount > 0 ? ` · 折叠 ${layout.hiddenCount}` : ''}
          {selection.size > 1 ? ` · 已选 ${selection.size}` : ''}
        </span>
        <span className="ml-auto truncate">
          {editable ? (
            <span className="inline-flex items-center gap-1">
              双击改名 · 右键更多 · <KeyboardIcon size={11} />
              看快捷键
            </span>
          ) : (
            `左键拖=${tool === 'select' ? '框选' : '平移'} · 右键查看`
          )}
        </span>
      </div>
    </div>
  )

  return (
    <>
      {fullscreen ? (
        <div className="fixed inset-0 z-30 bg-slate-900/50 p-5">
          <div
            ref={wrapRef}
            className="w-full h-full bg-white rounded-xl border border-gray-300 shadow-2xl overflow-hidden"
          >
            {inner}
          </div>
        </div>
      ) : (
        <div
          ref={wrapRef}
          className="w-full h-full bg-white rounded-lg border border-gray-200 overflow-hidden"
        >
          {inner}
        </div>
      )}

      {menu && menuNode && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)} />
          <ContextMenu
            x={menu.x}
            y={menu.y}
            nodeId={menu.id}
            label={menuNode.label}
            collapsed={collapsed.has(menu.id)}
            hasChildren={index.withKids.has(menu.id)}
            isNote={menuNode.note}
            isRoot={menu.id === index.rootId}
            focusId={focusId}
            editable={editable}
            onClose={() => setMenu(null)}
            actions={actions}
          />
        </>
      )}

      {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}
    </>
  )
}

// ------------------------------------------------------------------ 小组件

function TBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`shrink-0 text-[10px] px-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition ${MIN_TAPPABLE}`}
    >
      {children}
    </button>
  )
}

function ContextMenu({
  x,
  y,
  nodeId,
  label,
  collapsed,
  hasChildren,
  isNote,
  isRoot,
  focusId,
  editable,
  onClose,
  actions,
}: {
  x: number
  y: number
  nodeId: string
  label: string
  collapsed: boolean
  hasChildren: boolean
  /** 当前节点是笔记节点：时间相关项全部禁用（它不在时间轴上） */
  isNote: boolean
  isRoot: boolean
  focusId: string | null
  editable: boolean
  onClose: () => void
  actions: MindViewActions
}) {
  // 贴着窗口边缘右键时把菜单拉回来，否则下半截会跑到屏幕外点不到
  const W = 204
  const H = 304
  const left = Math.min(x, (typeof window === 'undefined' ? 1440 : window.innerWidth) - W - 8)
  const top = Math.min(y, (typeof window === 'undefined' ? 900 : window.innerHeight) - H - 8)

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div
      className="fixed z-50 bg-white border border-gray-200 rounded-md shadow-lg py-1 text-[12px] min-w-[204px]"
      style={{ left, top }}
    >
      <div className="px-3 py-1 text-[10px] text-gray-400 border-b border-gray-100 truncate max-w-[196px]">
        {label}
      </div>
      {!editable && (
        <div className="px-3 py-1 text-[10px] text-gray-400 border-b border-gray-100">
          只读模式：改内容请先点工具栏「只读」切到编辑模式
        </div>
      )}
      <Item
        kbd="F2"
        disabled={!editable}
        onClick={run(() => actions.beginEdit(nodeId, 'label'))}
      >
        重命名
      </Item>
      <Item kbd="Tab" disabled={!editable} onClick={run(() => actions.addChild(nodeId))}>
        新增子节点
      </Item>
      <Item
        kbd="Enter"
        disabled={!editable || isRoot}
        onClick={run(() => actions.addSibling(nodeId))}
      >
        新增同级节点
      </Item>
      <Item
        disabled={!editable}
        onClick={run(() => actions.addNote(nodeId))}
        title="笔记节点没有时间范围，也不影响父节点的时间范围"
      >
        新增笔记节点（无时间）
      </Item>
      <Item
        disabled={!editable || hasChildren || isNote}
        onClick={run(() => actions.beginEdit(nodeId, 'time'))}
      >
        {isNote ? '笔记节点没有时间范围' : hasChildren ? '时间范围由子节点决定' : '设置时间范围'}
      </Item>
      <Item
        onClick={run(() => actions.openNote(nodeId))}
        title="在这块面板里写 Markdown：支持标题、列表、表格、代码块"
      >
        笔记（Markdown）
      </Item>
      <div className="my-1 border-t border-gray-100" />
      <Item kbd="Ctrl+/" onClick={run(() => actions.toggleCollapse(nodeId))} disabled={!hasChildren}>
        {collapsed ? '展开分支' : '折叠分支'}
      </Item>
      <Item
        onClick={run(() => actions.collapseDeep(nodeId))}
        disabled={!hasChildren}
      >
        折叠整个子树（含后代）
      </Item>
      <Item onClick={run(() => actions.focusBranch(nodeId))}>
        {focusId === nodeId ? '取消聚焦' : '仅显示该分支'}
      </Item>
      <Item disabled={!editable} onClick={run(() => actions.rescale(nodeId, 0.2))}>
        放大 A+
      </Item>
      <Item disabled={!editable} onClick={run(() => actions.rescale(nodeId, -0.2))}>
        缩小 A-
      </Item>
      <div className="my-1 border-t border-gray-100" />
      <Item
        kbd="Del"
        danger
        disabled={!editable || isRoot}
        onClick={run(() => actions.remove(nodeId))}
      >
        删除节点
      </Item>
    </div>
  )
}

function Item({
  children,
  onClick,
  kbd,
  danger,
  disabled,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  kbd?: string
  danger?: boolean
  disabled?: boolean
  /** 悬停说明：有些项的置灰原因不写在标题上就在别处看不到 */
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'w-full flex items-center gap-2 px-3 py-1.5 text-left transition',
        disabled
          ? 'text-gray-300 cursor-default'
          : danger
            ? 'text-red-600 hover:bg-red-50'
            : 'text-gray-700 hover:bg-gray-100',
      ].join(' ')}
    >
      <span className="flex-1 truncate">{children}</span>
      {kbd && <span className="text-[10px] text-gray-400 shrink-0">{kbd}</span>}
    </button>
  )
}

const SHORTCUTS: [string, string][] = [
  ['鼠标工具（工具栏右侧「框选 / 平移」切换）', ''],
  ['左键拖画布', '框选模式下拉出选框，平移模式下挪动视角'],
  ['空格 + 拖动', '任何时候都能临时平移画布'],
  ['滚轮', '缩放'],
  ['只读模式（默认）', ''],
  ['单击节点', '选中该节点并跳转到它的时间戳'],
  ['Ctrl + F', '搜索节点，Enter 跳下一个'],
  ['Ctrl + /', '折叠或展开当前分支'],
  ['↑ ↓', '在可见节点间移动选中'],
  ['→ / ←', '展开 / 折叠，或跳到子节点 / 父节点'],
  ['Esc', '退出搜索 / 聚焦 / 取消选中'],
  ['编辑模式（点工具栏「只读」切换）', ''],
  ['单击节点', '只选中，不跳转播放'],
  ['顶部操作条', '对选中节点改名 / 加子节点 / 加同级 / 加笔记 / 改时间 / 折叠 / 删除'],
  ['Tab', '在当前节点下新增子节点'],
  ['Enter', '新增同级节点（根节点上是改名）'],
  ['F2 / 双击', '重命名当前节点'],
  ['Delete', '删除当前节点及其子节点'],
  ['拖拽节点', '手动摆放位置，「整理」可恢复自动布局'],
  ['拖节点右下角', '用鼠标改变这个节点的大小（字号和宽高一起变，80%–200%）'],
  ['+笔记', '新增一条不挂时间轴的笔记节点：没有时间范围，也不影响父节点的范围'],
  ['右键节点', '改名 / 增删 / 时间戳 / 折叠 / 聚焦 / 删除'],
  ['Shift+点折叠点', '连同所有后代一起折叠'],
]

function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/30" onMouseDown={onClose} />
      <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] max-w-[92vw] bg-white rounded-lg border border-gray-200 shadow-2xl p-4">
        <div className="flex items-center mb-3">
          <span className="text-sm font-semibold text-gray-900">操作说明</span>
          <IconButton
            icon={<CloseIcon size={16} />}
            label="关闭操作说明"
            onClick={onClose}
            className="ml-auto hover:text-gray-800 hover:bg-gray-100"
          />
        </div>
        <ul className="space-y-1.5 max-h-[70vh] overflow-y-auto thin-scroll">
          {SHORTCUTS.map(([key, desc]) =>
            desc === '' ? (
              <li key={key} className="pt-2 first:pt-0 text-[11px] font-semibold text-gray-800">
                {key}
              </li>
            ) : (
              <li key={key} className="flex items-center gap-3 text-[12px]">
                <kbd className="shrink-0 min-w-[104px] text-center px-1.5 py-0.5 rounded border border-gray-300 bg-gray-50 text-[11px] text-gray-700">
                  {key}
                </kbd>
                <span className="text-gray-600 truncate">{desc}</span>
              </li>
            ),
          )}
        </ul>
        <p className="mt-3 text-[11px] text-gray-400 leading-relaxed">
          键盘快捷键只在鼠标停在本面板内时生效，避免误伤其它区域的操作。
        </p>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ 折叠状态持久化

/**
 * 折叠是**视图状态**，不是导图数据。
 * 存 localStorage 而不是写进树里，有两个好处：折叠不触发保存请求（不会闪「保存中…」），
 * 后端也不用为一个纯 UI 字段改数据模型。按视频 id 分开存，切视频互不干扰。
 * 手动拖拽的节点偏移同理。
 */
const COLLAPSE_PREFIX = 'video-mind:mindmap-collapsed:v1:'
const OFFSET_PREFIX = 'video-mind:mindmap-offsets:v1:'
const EDITMODE_KEY = 'video-mind:mindmap-editmode:v1'

/** 编辑模式是用户偏好，跨视频保留，所以不和 videoId 绑定 */
function loadEditMode(): boolean {
  try {
    return localStorage.getItem(EDITMODE_KEY) === '1'
  } catch {
    return false
  }
}

function saveEditMode(on: boolean): void {
  try {
    localStorage.setItem(EDITMODE_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

interface NodeOffset {
  dx: number
  dy: number
}

function loadOffsets(videoId: number): Map<string, NodeOffset> {
  try {
    const raw = localStorage.getItem(OFFSET_PREFIX + videoId)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== 'object') return new Map()
    const out = new Map<string, NodeOffset>()
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const v = value as { dx?: unknown; dy?: unknown } | null
      if (v && typeof v.dx === 'number' && typeof v.dy === 'number') {
        out.set(key, { dx: v.dx, dy: v.dy })
      }
    }
    return out
  } catch {
    return new Map()
  }
}

function saveOffsets(videoId: number, map: Map<string, NodeOffset>): void {
  try {
    const obj: Record<string, NodeOffset> = {}
    for (const [k, v] of map) obj[k] = v
    localStorage.setItem(OFFSET_PREFIX + videoId, JSON.stringify(obj))
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

function loadCollapsed(videoId: number): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_PREFIX + videoId)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

function saveCollapsed(videoId: number, set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSE_PREFIX + videoId, JSON.stringify([...set]))
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}
