import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  withAlpha,
  type EditingTarget,
  type LaidOutNode,
  type LayoutResult,
  type MindTool,
  type MindViewActions,
} from '../lib/mindmapLayout'
import { formatTs } from '../lib/format'
import { parseTimestamp } from '../lib/mindmapEdit'
import { splitHighlight } from '../lib/highlight'

const BASE_FONT = 13
const ROOT_FONT = 15
const META_FONT = 10

interface MindNodeData extends Record<string, unknown> {
  node: LaidOutNode
  active: boolean
  selected: boolean
  matched: boolean
  dimmed: boolean
  query: string
  currentTime: number
  editing: EditingTarget
  /** 是否处于编辑模式。浏览模式下所有改写操作都必须锁住 */
  editable: boolean
  actions: MindViewActions
}

type MindFlowNode = Node<MindNodeData>

/**
 * 自定义节点：按 XMind 的默认主题分层——
 *   根节点实心填充 + 胶囊形、一级分支实心填充分支色、二级以下白底 + 分支色描边。
 *
 * 为什么要这样分层：只靠左边框色条表达深度的话，五个一级分支长得一模一样，
 * 扫一眼分不清「这段属于哪个章节」。给每个一级分支一个色相，
 * 子分支继承同一个色，归属关系不用读连线就看得出来。
 *
 * Handle 是 ReactFlow 画连线的锚点：自定义节点必须自己渲染它，
 * 否则整棵树的边会被静默丢弃——节点照常显示、连线一条没有，
 * 而且不报任何错。中心发散布局要按分支方向挑左右锚点，所以四个都渲染。
 */
function MindNode({ id, data }: NodeProps) {
  const d = data as MindNodeData
  const n = d.node
  const editing = d.editing && d.editing.id === id ? d.editing : null

  const [labelDraft, setLabelDraft] = useState(n.label)
  const [timeDraft, setTimeDraft] = useState(n.start === null ? '' : formatTs(n.start))

  // 进入编辑态时用树里的真实值重置草稿：节点组件是常驻的，
  // 不重置的话上一次编辑留下的旧值会一直显示在输入框里。
  useEffect(() => {
    if (!editing) return
    if (editing.field === 'label') setLabelDraft(n.label)
    else setTimeDraft(n.start === null ? '' : formatTs(n.start))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editing?.field, id])

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

  const isRoot = n.depth === 0
  const filled = n.depth <= 1
  const fg = filled ? '#ffffff' : '#1f2937'
  const radius = isRoot ? 999 : n.depth === 1 ? 10 : 8

  // 三层状态各用一层视觉，互不遮挡：
  //   选中 → outline（不占布局，圆环画在框外）
  //   正在播放 → 琥珀色描边 + 三角播放标记
  //   搜索命中 → 黄色描边（优先级最高，命中时优先让人看见）
  let ring = '0 1px 2px rgba(15,23,42,.10)'
  if (d.matched) ring = '0 0 0 2.5px rgba(250,204,21,.95), 0 1px 3px rgba(15,23,42,.18)'
  else if (d.active) ring = '0 0 0 2.5px rgba(245,158,11,.95), 0 1px 3px rgba(15,23,42,.18)'

  const startEditTime = () => d.actions.beginEdit(id, 'time')

  return (
    <>
      <Handle id="tl" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} isConnectable={false} />

      <div className="group relative w-full h-full">
        <div
          onClick={() => {
            if (editing) return
            d.actions.select(id)
            // 只在只读模式跳转：编辑模式里点节点是「选中」，
            // 一边改内容一边被播放器拖着走，改哪儿就跳哪儿，根本没法干活
            if (!d.editable && n.start !== null) d.actions.seek(n.start)
          }}
          onDoubleClick={() => {
            // 浏览模式下双击 = 再跳一次时间戳，而不是改名：
            // 只读模式下突然弹出输入框会让人怀疑自己是不是误触删掉了原文
            if (editing) return
            if (d.editable) d.actions.beginEdit(id, 'label')
            else if (n.start !== null) d.actions.seek(n.start)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            d.actions.select(id)
            d.actions.openMenu(id, e.clientX, e.clientY)
          }}
          title={
            d.editable
              ? n.start !== null
                ? `跳转到 ${formatTs(n.start)}（双击改名，右键更多操作）`
                : '该节点还没有设置时间戳（右键可设置）'
              : n.start !== null
                ? `跳转到 ${formatTs(n.start)}（浏览模式，点「编辑」才能改内容）`
                : '该节点还没有设置时间戳'
          }
          className="flex items-center gap-1.5 w-full h-full px-2.5 transition-shadow"
          style={{
            background: filled ? n.color : '#ffffff',
            color: fg,
            border: `1.5px solid ${filled ? n.color : withAlpha(n.color, 0.5)}`,
            borderRadius: radius,
            boxShadow: ring,
            outline: d.selected ? '2px solid #1e293b' : 'none',
            outlineOffset: 2,
            fontSize: `${(isRoot ? ROOT_FONT : BASE_FONT) * n.scale}px`,
          }}
        >
          {d.active && <span className="shrink-0 text-[9px] leading-none">▶</span>}

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
              className="nodrag flex-1 min-w-0 text-[13px] leading-tight px-1 py-0.5 rounded bg-white text-gray-900 outline-none"
              style={{ border: '1px solid #60a5fa' }}
            />
          ) : (
            <span
              className={[
                'flex-1 min-w-0 truncate leading-tight',
                isRoot ? 'font-semibold' : n.depth === 1 ? 'font-medium' : '',
              ].join(' ')}
            >
              {renderLabel(n.label, d.query)}
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
                className="nodrag w-[64px] text-[11px] tabular-nums px-1 py-0.5 rounded bg-white text-gray-900 outline-none"
                style={{ border: '1px solid #60a5fa' }}
              />
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTimeDraft(formatTs(d.currentTime))}
                title="填入当前播放时间"
                className="text-[10px] px-1 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
              >
                当前
              </button>
            </span>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation()
                // 编辑模式下改时间走顶部固定的节点操作条，这里只做只读展示
                if (!d.editable) {
                  if (n.start !== null) d.actions.seek(n.start)
                  return
                }
                startEditTime()
              }}
              title={
                d.editable
                  ? '点击设置/修改时间戳（支持 1:23 这样的写法）'
                  : n.start !== null
                    ? '跳转到该时间（浏览模式不可修改，点「编辑」后可改）'
                    : '该节点还没有设置时间戳'
              }
              // nodrag：节点现在可以拖动了，没有它时从时间戳徽章上按下鼠标
              // 会变成拖动整节点，而不是打开时间输入
              className="nodrag ml-auto shrink-0 rounded px-1 tabular-nums"
              style={{
                fontSize: `${META_FONT * n.scale}px`,
                background: filled ? 'rgba(255,255,255,.22)' : '#f1f5f9',
                color: filled ? '#ffffff' : '#64748b',
                cursor: d.editable ? 'text' : 'pointer',
              }}
            >
              {n.start === null ? '设时间' : formatTs(n.start)}
            </button>
          )}
        </div>

        {/* 折叠圆点：大树的生命线。折叠时直接显示被藏起来的后代数量，
            让人知道「这里还有东西」而不是单纯消失了。 */}
        {n.hasChildren && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            // Shift + 点击 = 连同所有后代一起折叠，省得一层层点下去
            onClick={(e) => {
              e.stopPropagation()
              if (e.shiftKey) d.actions.collapseDeep(id)
              else d.actions.toggleCollapse(id)
            }}
            title={
              n.collapsed
                ? `展开 ${n.hiddenCount} 个子节点（Shift+点击可连同后代一起折叠）`
                : '折叠该分支（Shift+点击连同后代一起折叠）'
            }
            className="nodrag absolute flex items-center justify-center rounded-full font-medium tabular-nums"
            style={{
              width: 18,
              height: 18,
              fontSize: 10,
              lineHeight: 1,
              background: n.collapsed ? n.color : '#ffffff',
              color: n.collapsed ? '#ffffff' : n.color,
              border: `1.5px solid ${n.color}`,
              boxShadow: '0 1px 2px rgba(15,23,42,.16)',
              ...(isRoot
                ? { left: '50%', bottom: -9, transform: 'translateX(-50%)' }
                : n.side === 1
                  ? { right: -9, top: '50%', transform: 'translateY(-50%)' }
                  : { left: -9, top: '50%', transform: 'translateY(-50%)' }),
            }}
          >
            {n.collapsed ? n.hiddenCount : '−'}
          </button>
        )}

        {/*
          节点上不再挂悬浮工具条：它钉在节点下方，密集导图里必然被下方节点遮住，
          而且为了不挡正文又做得极小。编辑操作统一走顶部固定的「节点操作条」，
          位置恒定、不会被遮挡，按钮能做得大得多。
        */}
      </div>
    </>
  )
}

/** 搜索命中的片段标黄。关键词来自用户输入，splitHighlight 内部用 indexOf，天然免疫正则注入。 */
function renderLabel(label: string, query: string) {
  if (!query.trim()) return label
  return splitHighlight(label, query).map((p, i) =>
    p.hit ? (
      <mark key={i} className="bg-yellow-200 rounded-sm px-0.5" style={{ color: 'inherit' }}>
        {p.text}
      </mark>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  )
}

const nodeTypes = { mind: MindNode }

export interface CanvasProps {
  /** 布局由容器统一算好传进来：画布与大纲共用同一次布局结果，避免重复计算 */
  layout: LayoutResult
  focusId: string | null
  selectedId: string | null
  activeId: string | null
  matches: ReadonlySet<string>
  query: string
  currentTime: number
  editing: EditingTarget
  actions: MindViewActions
  /** 编辑模式开关。浏览模式下只读 + 可框选，编辑模式下可改内容 */
  editable: boolean
  /** 左键拖画布的含义：框选还是平移。独立于编辑模式，由用户自己切 */
  tool: MindTool
  /** 框选/点选得到的节点集合，用于多选环与「整体拖拽」 */
  selection: ReadonlySet<string>
  /** 每自增一次就把当前选中节点带到视口中央（键盘导航 / 搜索跳转时才自增） */
  revealTick: number
  /** 拖拽结束时上报每个被挪动节点的最终位置（多选时会有多个） */
  onDragStop?: (moved: { id: string; x: number; y: number }[]) => void
  onSelectionChange?: (ids: string[]) => void
}

export default function MindMapCanvas(props: CanvasProps) {
  // useReactFlow 必须在 Provider 内部使用，所以外层只负责套一层 Provider。
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({
  layout,
  focusId,
  selectedId,
  activeId,
  matches,
  query,
  currentTime,
  editing,
  actions,
  editable,
  tool,
  selection,
  revealTick,
  onDragStop,
  onSelectionChange,
}: CanvasProps) {
  const { fitView, setCenter, getZoom } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)

  // 整秒取整：播放时 currentTime 每 250ms 一变，
  // 直接用原值会让整棵树的节点对象每秒重建四次，白烧性能。
  const coarseTime = Math.floor(currentTime)

  const { nodes, edges } = useMemo(() => {
    const byId = new Map(layout.nodes.map((n) => [n.id, n]))
    const dimming = query.trim().length > 0

    const flowNodes: MindFlowNode[] = layout.nodes.map((n) => ({
      id: n.id,
      type: 'mind',
      position: { x: n.x, y: n.y },
      // width/height 除了控制渲染，还是 MiniMap 判断「节点有没有尺寸」的依据——
      // 只写在 style 里时缩略图会判定全部节点无尺寸，整块缩略图变成一片空白。
      width: n.width,
      height: n.height,
      // 让自定义节点撑满布局算出的宽高，文字截断交给节点内部处理
      style: {
        width: n.width,
        height: n.height,
        padding: 0,
        border: 'none',
        background: 'transparent',
        // 搜索时把没命中的分支压暗，视线自然被拽到命中项上
        opacity: dimming && !matches.has(n.id) ? 0.26 : 1,
      },
      data: {
        node: n,
        active: n.id === activeId,
        selected: n.id === selectedId,
        matched: dimming && matches.has(n.id),
        dimmed: dimming && !matches.has(n.id),
        query,
        currentTime: coarseTime,
        editing,
        editable,
        actions,
      },
      /*
        ⚠️ 不要再给节点 draggable:false / selectable:false。
        ReactFlow 判定「这个节点要不要接收鼠标」的条件是
        isSelectable || isDraggable || 有点击回调；三者都为否时它会给节点
        打上 pointer-events:none —— 节点看着还在，但点击直接穿透到画布：
        点不动、拖不动、双击也进不了编辑，只有键盘能用。
        踩过一次，别回退。禁止连线所以用 connectable:false 就够了。
      */
      connectable: false,
      // 多选/框选的选中态由容器持有，这里同步给 ReactFlow：
      // 多选拖拽需要 ReactFlow 知道哪些节点是一组的，否则只会拖走一个
      selected: selection.has(n.id),
    }))

    // 连线：中心发散布局里「从中心往外」本身就是方向，不需要箭头。
    // 改用「根粗叶细 + 分支同色」表达层级——越往外越细，主干一眼就认得出来。
    const flowEdges: Edge[] = []
    for (const n of layout.nodes) {
      if (!n.parentId) continue
      if (!byId.has(n.parentId)) continue
      const outward = n.side === 1 ? 'sr' : 'sl'
      const inward = n.side === 1 ? 'tl' : 'tr'
      flowEdges.push({
        id: `e-${n.parentId}-${n.id}`,
        source: n.parentId,
        target: n.id,
        sourceHandle: outward,
        targetHandle: inward,
        type: 'default',
        style: {
          stroke: n.color,
          strokeWidth: Math.max(1.2, 3.4 - n.depth * 0.8),
          opacity: dimming && !matches.has(n.id) ? 0.25 : 1,
        },
      })
    }
    return { nodes: flowNodes, edges: flowEdges }
  }, [layout, activeId, selectedId, selection, matches, query, coarseTime, editing, editable, actions])

  /**
   * 结构变了才重新铺满：折叠、聚焦、搜索、切换视频都会改变节点总数，
   * 这时不 refit 就会留一大片空白或把树顶出视口。
   * 只在这些「结构性」信号变化时做，避免播放时每次高亮都把用户调好的缩放冲掉。
   */
  const structureKey = `${layout.visibleCount}|${focusId ?? ''}|${query.trim()}`
  useEffect(() => {
    const t = window.setTimeout(() => fitView({ padding: 0.18, duration: 220 }), 30)
    return () => window.clearTimeout(t)
  }, [structureKey, fitView])

  // 面板被拖宽/拖窄后自动重新铺满。只在宽度变化超过 60px 时才 refit：
  // 拖动过程中的每像素抖动都 refit 会让人眼晕。
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
        if (meaningful) fitView({ padding: 0.18, duration: 200 })
      }, 250)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [fitView])

  // 键盘导航 / 搜索跳转：把选中节点带到视口中心。
  // 只有 revealTick 自增时才做——普通点击不该让画布乱跳。
  useEffect(() => {
    if (!revealTick || !selectedId) return
    const n = layout.nodes.find((x) => x.id === selectedId)
    if (!n) return
    setCenter(n.x + n.width / 2, n.y + n.height / 2, {
      zoom: Math.max(getZoom(), 0.75),
      duration: 250,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick])

  const onPaneClick = useCallback(() => {
    actions.select(null)
    onSelectionChange?.([])
  }, [actions, onSelectionChange])

  /** 拖拽结束时才上报位移：拖动中的每次 mousemove 都写状态会让画布疯狂重渲染 */
  const handleDragStop: NonNullable<CanvasProps['onDragStop']> = (moved) => onDragStop?.(moved)

  /** 把 ReactFlow 的选中结果（点击单选 / 按住拖=框选）同步回容器 */
  const handleSelectionChange = useCallback(
    (params: { nodes: Node[] }) => onSelectionChange?.(params.nodes.map((n) => n.id)),
    [onSelectionChange],
  )

  return (
    <div ref={wrapRef} className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onPaneClick={onPaneClick}
        onNodeDragStop={(_e, _node, moved) =>
          handleDragStop(moved.map((m) => ({ id: m.id, x: m.position.x, y: m.position.y })))
        }
        onSelectionChange={handleSelectionChange}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        /*
          ⚠️ elementsSelectable 必须为 true，否则框选一个节点也选不中
          （ReactFlow 用 selectable 决定是否纳入 selection 区域相交计算）。
          之前为了「不用它的默认蓝框」关过一次，代价就是彻底没法框选。
        */
        elementsSelectable
        /*
          左键拖画布的含义由 tool 决定，与编辑模式解耦：
            select → 框选（部分命中，碰到就算选中；要求完整框住几乎选不中东西）
            pan    → 平移画布
          空格 + 拖动始终可以临时平移（panActivationKeyCode），这是应急通道。
        */
        selectionOnDrag={tool === 'select'}
        selectionMode={SelectionMode.Partial}
        panOnDrag={tool === 'pan'}
        panActivationKeyCode="Space"
        zoomOnScroll
      >
        <Background color="#e6eaf0" gap={18} />
        <Controls showInteractive={false} />
        {/*
          缩略图改为纯展示：见 index.css 的 .react-flow__minimap 规则。
          它是覆盖在画布上的面板，接收鼠标就会吃掉下方节点的点击。
          缩放/定位用工具栏的「适应画布」和拖拽画布完成，不损失什么。
        */}
        <MiniMap
          pannable={false}
          zoomable={false}
          nodeColor={(n) => (n.data as unknown as MindNodeData)?.node?.color ?? '#93c5fd'}
          style={{ background: '#f8fafc' }}
        />
      </ReactFlow>
    </div>
  )
}
