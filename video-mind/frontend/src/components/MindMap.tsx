import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import type { MindMapNode } from '../types'
import { layoutMindMap } from '../lib/mindmapLayout'
import { formatTs } from '../lib/format'
import {
  addChildNode,
  findNode,
  nextScale,
  parseTimestamp,
  removeNodeById,
  updateNode,
} from '../lib/mindmapEdit'

const BASE_FONT = 13
const META_FONT = 10

/** 当前正在编辑哪个节点的哪一栏 */
type EditingTarget = { id: string; field: 'label' | 'time' } | null

interface NodeActions {
  seek: (t: number) => void
  beginEdit: (id: string, field: 'label' | 'time') => void
  cancelEdit: () => void
  commitLabel: (id: string, label: string) => void
  commitTime: (id: string, seconds: number | null) => void
  addChild: (id: string) => void
  remove: (id: string) => void
  rescale: (id: string, delta: number) => void
}

interface MindNodeData extends Record<string, unknown> {
  label: string
  start: number | null
  depth: number
  scale: number
  active: boolean
  currentTime: number
  editable: boolean
  editing: EditingTarget
  actions: NodeActions
}

type MindFlowNode = Node<MindNodeData>

/**
 * 自定义节点。
 *
 * 视觉上用「左边框的颜色条」表达层级：根=深色、一级=蓝、二级=青，
 * 这样即使不依赖颜色也能靠深浅分辨层次（照顾色觉障碍用户）。
 *
 * 节点尺寸与字号都由 scale 驱动：scale 既放大方框，也放大文字，
 * 保证「放大的节点一眼看上去就是更重要」，而不是大框里塞小字。
 */
function MindNode({ id, data }: NodeProps) {
  const d = data as MindNodeData
  const depth = d.depth ?? 0
  const scale = d.scale || 1
  const editing = d.editing && d.editing.id === id ? d.editing : null

  const barColor =
    depth === 0 ? '#4f46e5' : depth === 1 ? '#2563eb' : depth === 2 ? '#0891b2' : '#64748b'

  const bg =
    depth === 0
      ? 'bg-indigo-50 border-indigo-300'
      : depth === 1
        ? 'bg-blue-50 border-blue-200'
        : 'bg-white border-gray-200'

  const [labelDraft, setLabelDraft] = useState(d.label)
  const [timeDraft, setTimeDraft] = useState(d.start === null ? '' : formatTs(d.start))

  const startLabelEdit = () => {
    setLabelDraft(d.label)
    d.actions.beginEdit(id, 'label')
  }
  const startTimeEdit = () => {
    setTimeDraft(d.start === null ? '' : formatTs(d.start))
    d.actions.beginEdit(id, 'time')
  }

  const submitLabel = () => {
    d.actions.commitLabel(id, labelDraft.trim())
    d.actions.cancelEdit()
  }
  const submitTime = () => {
    const text = timeDraft.trim()
    if (!text) {
      // 清空 = 取消这个节点的时间戳（连带删掉由它生成的章节）
      d.actions.commitTime(id, null)
    } else {
      const seconds = parseTimestamp(text)
      if (seconds === null) return // 输入不合法就保持编辑态，让用户改
      d.actions.commitTime(id, seconds)
    }
    d.actions.cancelEdit()
  }

  return (
    <>
      {/*
        Handle 是 ReactFlow 画连线的锚点：自定义节点必须自己渲染它，
        否则整棵树的边会被静默丢弃——节点照常显示、连线一条没有，
        而且不报任何错，表现为「看不出层级关系」却查不出原因。
        外观交给 index.css 的 .react-flow__handle{opacity:0} 隐藏，
        交互也不用它，节点整体就是点击热区。
      */}
      <Handle type="target" position={Position.Left} isConnectable={false} />

      <div className="group relative w-full h-full">
        <div
          onClick={() => {
            if (editing) return
            if (d.start !== null) d.actions.seek(d.start)
          }}
          title={d.start !== null ? `跳转到 ${formatTs(d.start)}` : '该节点还没有设置时间戳'}
          className={[
            'flex items-center gap-2 rounded-md border px-3 py-2 shadow-sm transition-transform',
            'hover:shadow-md hover:-translate-y-px',
            bg,
            d.active ? 'ring-2 ring-blue-500 border-blue-500' : '',
            d.start === null ? 'cursor-default opacity-70' : 'cursor-pointer',
          ].join(' ')}
          style={{ width: '100%', height: '100%' }}
        >
          <span
            className="w-1 self-stretch rounded-full shrink-0"
            style={{ background: barColor }}
          />

          {editing?.field === 'label' ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={submitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitLabel()
                if (e.key === 'Escape') d.actions.cancelEdit()
              }}
              onClick={(e) => e.stopPropagation()}
              className="nodrag flex-1 min-w-0 text-[13px] leading-tight px-1.5 py-0.5 rounded border border-blue-400 bg-white outline-none"
            />
          ) : (
            <span
              onDoubleClick={d.editable ? startLabelEdit : undefined}
              title={d.editable ? '双击修改内容' : undefined}
              className={[
                'leading-tight truncate',
                depth === 0 ? 'font-semibold text-indigo-900' : 'text-gray-800',
              ].join(' ')}
              style={{ fontSize: `${BASE_FONT * scale}px` }}
            >
              {d.label}
            </span>
          )}

          {editing?.field === 'time' ? (
            <span
              className="ml-auto flex items-center gap-1 shrink-0 nodrag"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                value={timeDraft}
                onChange={(e) => setTimeDraft(e.target.value)}
                onBlur={submitTime}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTime()
                  if (e.key === 'Escape') d.actions.cancelEdit()
                }}
                placeholder="1:23 或 83"
                className="nodrag w-[76px] text-[11px] tabular-nums px-1 py-0.5 rounded border border-blue-400 bg-white outline-none"
              />
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTimeDraft(formatTs(d.currentTime))}
                title="填入当前播放时间"
                className="text-[10px] px-1 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50"
              >
                当前
              </button>
            </span>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (d.editable) startTimeEdit()
              }}
              title={d.editable ? '点击设置/修改时间戳（支持 1:23 这样的写法）' : undefined}
              className={[
                'ml-auto tabular-nums shrink-0 rounded px-1',
                d.editable ? 'hover:bg-black/5 text-gray-400' : 'text-gray-400',
              ].join(' ')}
              style={{ fontSize: `${META_FONT * scale}px` }}
            >
              {d.start === null ? '设置时间' : formatTs(d.start)}
            </button>
          )}
        </div>

        {/* 工具条：悬停或正在编辑时出现。
            放在节点框外侧上方，避免把正文挤掉；nodrag 防止误触发画布拖拽。 */}
        {d.editable && (
          <div
            className={[
              'nodrag absolute -top-7 right-0 flex items-center gap-1 bg-white/95 border border-gray-200 rounded px-1 py-0.5 shadow-sm',
              'opacity-0 group-hover:opacity-100 transition-opacity',
              editing ? 'opacity-100' : '',
            ].join(' ')}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <ToolBtn onClick={startLabelEdit} title="修改内容">
              改名
            </ToolBtn>
            <ToolBtn onClick={startTimeEdit} title="设置时间戳，并生成对应章节">
              时间
            </ToolBtn>
            <ToolBtn onClick={() => d.actions.addChild(id)} title="在此节点下新增一个子节点">
              +子
            </ToolBtn>
            <ToolBtn onClick={() => d.actions.rescale(id, 0.2)} title="放大节点（文字同步变大）">
              A+
            </ToolBtn>
            <ToolBtn onClick={() => d.actions.rescale(id, -0.2)} title="缩小节点">
              A-
            </ToolBtn>
            <ToolBtn
              onClick={() => d.actions.remove(id)}
              title="删除该节点及其子节点"
              danger
            >
              删除
            </ToolBtn>
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}

function ToolBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
  danger?: boolean
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title={title}
      className={[
        'text-[10px] leading-none px-1.5 py-1 rounded border transition',
        danger
          ? 'border-transparent text-red-500 hover:bg-red-50 hover:border-red-200'
          : 'border-transparent text-gray-500 hover:bg-gray-100 hover:border-gray-200',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

const nodeTypes = { mind: MindNode }

interface Props {
  tree: MindMapNode
  currentTime: number
  onSeek: (t: number) => void
  /** 保存整棵树；由 App 负责调接口并刷新详情（章节会跟着变） */
  onSaveTree: (tree: MindMapNode) => Promise<void>
}

export default function MindMap(props: Props) {
  // useReactFlow 必须在 Provider 内部使用，所以外层只负责套一层 Provider。
  // 需要它才能拿到 fitView：面板变宽后要让导图重新铺满，而不是留一片空白。
  return (
    <ReactFlowProvider>
      <MindMapCanvas {...props} />
    </ReactFlowProvider>
  )
}

function MindMapCanvas({ tree, currentTime, onSeek, onSaveTree }: Props) {
  const { fitView } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<EditingTarget>(null)
  const [saving, setSaving] = useState(false)

  // 计算「当前所处节点」：取所有 start <= currentTime 中 start 最大的那个。
  // 这比「判断落在区间内」更稳——节点时间戳是稀疏的，区间判断会频繁落空。
  // 用两个基础类型变量而不是一个对象：闭包内对对象反复赋值会让 TS 的控制流
  // 推断退化成 never，拆成基础类型既绕开这个问题，意图也更直白。
  const activeId = useMemo(() => {
    let bestId: string | null = null
    let bestStart = -Infinity
    const walk = (node: MindMapNode, fallback: string) => {
      const id = node.id || fallback
      const s = node.start
      if (s !== null && s !== undefined && s <= currentTime && s > bestStart) {
        bestId = id
        bestStart = s
      }
      ;(node.children ?? []).forEach((c, i) => walk(c, `${id}-${i}`))
    }
    walk(tree, 'n0')
    return bestId
  }, [tree, currentTime])

  const commit = useCallback(
    async (next: MindMapNode) => {
      setSaving(true)
      try {
        await onSaveTree(next)
      } finally {
        setSaving(false)
      }
    },
    [onSaveTree],
  )

  const actions: NodeActions = useMemo(
    () => ({
      seek: onSeek,
      beginEdit: (id, field) => setEditing({ id, field }),
      cancelEdit: () => setEditing(null),
      commitLabel: (id, label) => {
        if (!label) return
        const { tree: next } = updateNode(tree, id, { label })
        void commit(next)
      },
      commitTime: (id, seconds) => {
        // pinned 记录「用户显式设过时间」：后端只为这类节点生成章节，
        // 免得改一次文案就冒出一堆继承时间戳的重复章节。
        const { tree: next } = updateNode(tree, id, { start: seconds, pinned: seconds !== null })
        void commit(next)
        // 立刻跳过去：设时间戳的人下一步就是「看看这个位置对不对」
        if (seconds !== null) onSeek(seconds)
      },
      addChild: (id) => {
        const { tree: next, id: newId, reason } = addChildNode(tree, id)
        if (!newId) {
          if (reason) alert(reason)
          return
        }
        void commit(next)
        setEditing({ id: newId, field: 'label' })
      },
      remove: (id) => {
        if (!confirm('删除该节点及其所有子节点？由它们生成的章节也会一并删除。')) return
        const { tree: next } = removeNodeById(tree, id)
        void commit(next)
      },
      rescale: (id, delta) => {
        const current = findNode(tree, id)?.scale
        const { tree: next } = updateNode(tree, id, { scale: nextScale(current, delta) })
        void commit(next)
      },
    }),
    [tree, commit, onSeek],
  )

  const { nodes, edges } = useMemo(() => {
    const layout = layoutMindMap(tree)
    const byId = new Map(layout.nodes.map((n) => [n.id, n]))

    const flowNodes: MindFlowNode[] = layout.nodes.map((n) => ({
      id: n.id,
      type: 'mind',
      position: { x: n.x, y: n.y },
      // 让自定义节点撑满布局算出的宽高，文字截断交给节点内部处理
      style: {
        width: n.width,
        height: n.height,
        padding: 0,
        border: 'none',
        background: 'transparent',
      },
      data: {
        label: n.label,
        start: n.start,
        depth: n.depth,
        scale: n.scale,
        active: n.id === activeId,
        currentTime,
        editable: true,
        editing,
        actions,
      },
      draggable: false,
      connectable: false,
    }))

    // 连线必须自己带层级语义：只画灰线的话，用户看到的是一堆散落的方框，
    // 看不出「谁属于谁」。这里按目标节点深度配色 + 加箭头指明方向，
    // 让「根 → 章节 → 要点」的归属一眼可读。
    const flowEdges: Edge[] = []
    for (const n of layout.nodes) {
      if (!n.parentId) continue
      const parent = byId.get(n.parentId)
      if (!parent) continue
      const color = n.depth <= 1 ? '#818cf8' : '#a5b4fc'
      flowEdges.push({
        id: `e-${n.parentId}-${n.id}`,
        source: n.parentId,
        target: n.id,
        type: 'smoothstep',
        style: { stroke: color, strokeWidth: n.depth <= 1 ? 2 : 1.5 },
        // 箭头是「归属方向」的关键，比单纯的颜色更能消除歧义
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color,
        },
      })
    }
    return { nodes: flowNodes, edges: flowEdges }
  }, [tree, activeId, currentTime, editing, actions])

  // 节点数据变化（尤其是 active 高亮）时需要通知 ReactFlow 重新测量
  const key = useMemo(() => nodes.map((n) => `${n.id}:${n.data.active ? 1 : 0}`).join('|'), [nodes])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const d = node.data as unknown as MindNodeData
      if (d?.start !== null && d?.start !== undefined) onSeek(d.start)
    },
    [onSeek],
  )

  /**
   * 面板被拖宽/拖窄后自动重新铺满画布。
   *
   * 不做这件事的话，把右栏从 420 拉到 900 只会多出一片空白，
   * 树还挤在左边——用户会觉得「放大了没用」。
   *
   * 只在宽度变化超过 60px 时才重新适应：拖动过程中的每像素抖动都 refit
   * 会让人眼晕，也会把用户手动调好的缩放冲掉。
   */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let lastWidth = 0
    let timer: number | undefined

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const meaningful = lastWidth === 0 || Math.abs(width - lastWidth) >= 60
        lastWidth = width
        if (meaningful) fitView({ padding: 0.15, duration: 200 })
      }, 250)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [fitView])

  return (
    <div className="w-full h-full flex flex-col bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-gray-400">
          双击改内容 · 点节点跳转 · 设时间戳会自动生成章节
        </span>
        <button
          onClick={() => fitView({ padding: 0.15, duration: 200 })}
          title="把整张导图缩放到当前面板大小"
          className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-800"
        >
          适应画布
        </button>
        <span className="text-[10px] text-gray-400">{saving ? '保存中…' : ''}</span>
      </div>

      <div ref={wrapRef} className="flex-1 min-h-0">
        <ReactFlow
          key={key}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          panOnDrag
          zoomOnScroll
        >
          <Background color="#eef1f5" gap={16} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              (n.data as unknown as MindNodeData)?.depth === 0 ? '#4f46e5' : '#93c5fd'
            }
            style={{ background: '#f8fafc' }}
          />
        </ReactFlow>
      </div>
    </div>
  )
}
