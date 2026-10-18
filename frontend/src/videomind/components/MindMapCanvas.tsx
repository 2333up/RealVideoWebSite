import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
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
import { splitHighlight } from '../lib/highlight'
import { clampScale, SCALE_MAX, SCALE_MIN } from '../lib/mindmapEdit'
import { MemoIcon, PlayIcon } from './icons'
import TimeRangeEditor from './TimeRangeEditor'

const BASE_FONT = 13
const ROOT_FONT = 15
const META_FONT = 10

interface MindNodeData extends Record<string, unknown> {
  node: LaidOutNode
  /**
   * 点击该节点要跳到的秒数。分类节点自身没有时间戳，
   * 取第一个有时间的后代——只有叶子才真正持有时间。
   */
  seekStart: number | null
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
  const note = n.note
  const editing = d.editing && d.editing.id === id ? d.editing : null
  const { getZoom } = useReactFlow()

  const [labelDraft, setLabelDraft] = useState(n.label)

  /**
   * 拖动右下角手柄改变节点大小。
   *
   * 换算链条：屏幕像素 → 画布像素（除以 zoom）→ 缩放系数。
   * 起手时把「不缩放时的自然宽度」和当时的 scale 一起存下来，
   * 之后每次移动都按位移重新算，而不是在上一帧的结果上累加——
   * 累加会因浮点误差和夹取丢失，快速来回拖时能明显感到「拖不回来」。
   */
  const resizeRef = useRef<{ x0: number; s0: number; w0: number; live: number } | null>(null)

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!d.editable) return
    e.stopPropagation()
    e.preventDefault()
    resizeRef.current = {
      x0: e.clientX,
      s0: n.scale || 1,
      w0: Math.max(1, n.width / (n.scale || 1)),
      live: n.scale || 1,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    d.actions.select(id)
  }

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current
    if (!r) return
    e.stopPropagation()
    const zoom = getZoom() || 1
    const dx = (e.clientX - r.x0) / zoom
    const next = clampScale((r.w0 * r.s0 + dx) / r.w0)
    r.live = next
    d.actions.previewScale(id, next)
  }

  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current
    if (!r) return
    resizeRef.current = null
    e.stopPropagation()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    d.actions.commitScale(id, r.live)
  }

  // 进入编辑态时用树里的真实值重置草稿：节点组件是常驻的，
  // 不重置的话上一次编辑留下的旧值会一直显示在输入框里。
  useEffect(() => {
    if (!editing) return
    if (editing.field === 'label') setLabelDraft(n.label)
    // 时间范围改由 TimeRangeEditor 自己持草稿：它有两个输入框，
    // 放在这里做受控状态会在「起点改一半、终点还没动」时被节点重渲染冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editing?.field, id])

  const submitLabel = () => {
    d.actions.commitLabel(id, labelDraft.trim())
    d.actions.cancelEdit()
  }

  const isRoot = n.depth === 0
  // 笔记节点永远浅底：它不在时间轴上，视觉上必须和「某个时间段的标题」区分开
  const filled = n.depth <= 1 && !note
  const fg = note ? '#92400e' : filled ? '#ffffff' : '#1f2937'
  const radius = isRoot ? 999 : n.depth === 1 ? 10 : 8

  // 三层状态各用一层视觉，互不遮挡：
  //   选中 → outline（不占布局，圆环画在框外）
  //   正在播放 → 琥珀色描边 + 三角播放标记
  //   搜索命中 → 黄色描边（优先级最高，命中时优先让人看见）
  let ring = '0 1px 2px rgba(15,23,42,.10)'
  if (d.matched) ring = '0 0 0 2.5px rgba(250,204,21,.95), 0 1px 3px rgba(15,23,42,.18)'
  else if (d.active) ring = '0 0 0 2.5px rgba(245,158,11,.95), 0 1px 3px rgba(15,23,42,.18)'

  const startEditTime = () => d.actions.beginEdit(id, 'time')

  /**
   * 节点上的时间徽章：有终点就显示「起–止」，只有起点就显示起点。
   *
   * 有子节点的节点，时间是子节点算出来的（起点取最早、终点取最晚）——
   * 它永远有值，除非它下面的叶子都还没设时间，这时显示「—」而不是「设时间」：
   * 这个位置本来就不接受手填，写着「设时间」会骗人去点。
   */
  /**
   * 节点上的时间徽章：有终点就显示「起–止」，只有起点就显示起点。
   *
   * 有子节点的节点，时间是子节点算出来的（起点取最早、终点取最晚）——
   * 它永远有值，除非它下面的叶子都还没设时间，这时显示「—」而不是「设时间」：
   * 这个位置本来就不接受手填，写着「设时间」会骗人去点。
   *
   * 笔记节点显示「笔记」：它不属于时间轴，写「设时间」同样是骗人。
   */
  const rangeText = note
    ? '笔记'
    : n.timedChildren
      ? n.start === null
        ? '—'
        : n.end !== null
          ? `${formatTs(n.start)}–${formatTs(n.end)}`
          : formatTs(n.start)
      : n.start === null
        ? '设时间'
        : n.end !== null
          ? `${formatTs(n.start)}–${formatTs(n.end)}`
          : formatTs(n.start)

  const hoverTitle = [
    note
      ? '笔记节点：不对应视频里的任何时间，不影响父节点的时间范围'
      : d.seekStart === null
        ? '该分支下还没有设置时间戳的节点'
        : n.timedChildren && n.start === null
          ? `跳转到 ${formatTs(d.seekStart)}（该分支没有自己的时间，跳到它第一个子节点）`
          : d.editable
            ? `跳转到 ${formatTs(d.seekStart)}（双击改名，右键更多操作）`
            : `跳转到 ${formatTs(d.seekStart)}（浏览模式，点「编辑」才能改内容）`,
    n.summary || '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return (
    <>
      <Handle id="tl" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} isConnectable={false} />

      <div className="group relative w-full h-full">
        <div
          data-note={note ? '1' : undefined}
          onClick={() => {
            if (editing) return
            d.actions.select(id)
            // 只在只读模式跳转：编辑模式里点节点是「选中」，
            // 一边改内容一边被播放器拖着走，改哪儿就跳哪儿，根本没法干活
            if (!d.editable && d.seekStart !== null) d.actions.seek(d.seekStart)
          }}
          onDoubleClick={() => {
            // 浏览模式下双击 = 再跳一次时间戳，而不是改名：
            // 只读模式下突然弹出输入框会让人怀疑自己是不是误触删掉了原文
            if (editing) return
            if (d.editable) d.actions.beginEdit(id, 'label')
            else if (d.seekStart !== null) d.actions.seek(d.seekStart)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            d.actions.select(id)
            d.actions.openMenu(id, e.clientX, e.clientY)
          }}
          title={hoverTitle}
          className="flex items-center gap-1.5 w-full h-full px-2.5 transition-shadow"
          style={{
            // 笔记节点：琥珀色虚线 + 浅底。它不在时间轴上，
            // 视觉上必须和「某个时间段的标题」一眼分开——实心填充太像分类节点
            background: note ? '#fffbeb' : filled ? n.color : '#ffffff',
            color: fg,
            border: `1.5px ${note ? 'dashed' : 'solid'} ${
              note ? 'rgba(217,119,6,.75)' : filled ? n.color : withAlpha(n.color, 0.5)
            }`,
            borderRadius: radius,
            boxShadow: ring,
            outline: d.selected ? '2px solid #1e293b' : 'none',
            outlineOffset: 2,
            fontSize: `${(isRoot ? ROOT_FONT : BASE_FONT) * n.scale}px`,
          }}
        >
          {/* 装饰性标记：整块节点就是跳转热区，它只负责「正在播」这一状态 */}
          {d.active && <PlayIcon size={9} />}

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

          {/* 有 Markdown 笔记的节点挂一个小本子图标：
              这是「这个节点有没有内容可读」唯一的线索，点它直接摊开笔记面板。
              放在时间徽章左边、且与「是否在编辑时间」无关——编辑时间时也该看得见。 */}
          {n.hasNote && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                d.actions.openNote(id)
              }}
              title="这个节点有笔记（Markdown）｜点击查看"
              aria-label={`查看节点「${n.label}」的笔记`}
              data-role="note-mark"
              className="nodrag shrink-0 inline-flex items-center justify-center rounded hover:bg-black/10"
              style={{
                width: 14,
                height: 14,
                color: filled ? 'rgba(255,255,255,.9)' : '#b45309',
              }}
            >
              <MemoIcon size={Math.max(10, Math.round(11 * n.scale))} />
            </button>
          )}

          {editing?.field === 'time' ? (
            // 两个输入框塞不进节点里，浮在节点下方：节点本身只有 180px 宽，
            // 挤进去会把标题压得只剩两三个字。
            <TimeRangeEditor
              variant="popover"
              start={n.start}
              end={n.end}
              currentTime={d.currentTime}
              onSubmit={(s, e) => {
                d.actions.commitRange(id, s, e)
                d.actions.cancelEdit()
              }}
              onCancel={() => d.actions.cancelEdit()}
            />
          ) : (
            // 时间徽章：叶子可改；有子节点的节点只展示（时间由子节点算出来）；
            // 笔记节点显示「笔记」，点了什么都不做——它没有时间可跳、也没得改
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (note) return
                // 编辑模式下改时间走顶部固定的节点操作条，这里只做只读展示；
                // 有子节点的节点时间不可改，点它就当「跳到这一段的开头」
                if (!d.editable || n.timedChildren) {
                  if (n.start !== null) d.actions.seek(n.start)
                  return
                }
                startEditTime()
              }}
              title={
                note
                  ? '笔记节点不对应视频里的任何时间（也不影响父节点的时间范围）'
                  : n.timedChildren
                    ? `时间范围由子节点决定（起点取最早、终点取最晚）：${rangeText}｜点击跳到此处`
                    : d.editable
                      ? '点击设置/修改时间戳（支持 1:23 这样的写法）'
                      : n.start !== null
                        ? `跳转到 ${rangeText === '设时间' ? formatTs(n.start) : rangeText}（浏览模式不可修改，点「编辑」后可改）`
                        : '该节点还没有设置时间戳'
              }
              // nodrag：节点现在可以拖动了，没有它时从时间戳徽章上按下鼠标
              // 会变成拖动整节点，而不是打开时间输入
              data-role="time-badge"
              className="nodrag ml-auto shrink-0 rounded px-1 tabular-nums"
              style={{
                fontSize: `${META_FONT * n.scale}px`,
                background: note ? '#fef3c7' : filled ? 'rgba(255,255,255,.22)' : '#f1f5f9',
                color: note ? '#b45309' : filled ? '#ffffff' : '#64748b',
                cursor: note ? 'default' : d.editable && !n.timedChildren ? 'text' : 'pointer',
              }}
            >
              {rangeText}
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
          缩放手柄：编辑模式下用鼠标拖动这里改变节点大小（字号、宽高一起变）。
          放在节点右下角外侧一点点，不压住正文；只在悬停/选中时显现，
          否则密集导图里每个角上都挂一个三角，看着很脏。
          nodrag 是必须的：没有它，ReactFlow 会把这个 pointerdown 当成拖动节点。
        */}
        {d.editable && (
          <div
            role="slider"
            aria-label={`调整节点「${n.label}」的大小`}
            aria-valuemin={SCALE_MIN}
            aria-valuemax={SCALE_MAX}
            aria-valuenow={Math.round(n.scale * 100) / 100}
            title={`拖动改变节点大小（当前 ${Math.round(n.scale * 100)}%，${SCALE_MIN}–${SCALE_MAX}）`}
            data-role="resize-handle"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            onDoubleClick={(e) => e.stopPropagation()}
            className={[
              'nodrag nopan absolute flex items-end justify-end transition-opacity',
              d.selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            ].join(' ')}
            style={{
              right: -2,
              bottom: -2,
              width: 15,
              height: 15,
              cursor: 'nwse-resize',
              color: note ? '#b45309' : n.color,
              // 触控区 15px 偏小，用一层透明外扩把可点面积加到约 24px
              padding: 0,
              touchAction: 'none',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
              <path
                d="M14 4.5 L4.5 14 M14 9 L9 14"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                fill="none"
              />
              <circle cx="14" cy="14" r="2.2" fill="currentColor" />
            </svg>
          </div>
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
  /** 当前视频 id：切视频时要重新铺满（布局基准全变了） */
  videoId: number
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
  /** 节点 id → 点击时跳转的秒数（分类节点向下找第一个有时间的后代） */
  seekTimeOf: ReadonlyMap<string, number | null>
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
  videoId,
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
  seekTimeOf,
  selection,
  revealTick,
  onDragStop,
  onSelectionChange,
}: CanvasProps) {
  const { fitView, setCenter, getZoom, flowToScreenPosition } = useReactFlow()
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
        seekStart: seekTimeOf.get(n.id) ?? n.start,
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
  }, [
    layout,
    activeId,
    selectedId,
    selection,
    seekTimeOf,
    matches,
    query,
    coarseTime,
    editing,
    editable,
    actions,
  ])

  /**
   * 什么时候重新铺满（fitView）。
   *
   * **只看「换了一种看法」的信号，绝不含节点数量**：早先这里用的是
   * `layout.visibleCount`，于是「新增 / 删除一个节点」也会触发 fitView——
   * 用户刚调好的缩放与位置被整个重置（实测 0.462 → 0.385），
   * 看起来就是「加个节点，整页重来一遍」。节点增减是**编辑**，不是换视角。
   *
   * 真正该重置的只有四件事：切视频、折叠/展开、聚焦、搜索。
   */
  const collapsedSig = layout.nodes
    .filter((n) => n.collapsed)
    .map((n) => n.id)
    .sort()
    .join(',')
  const structureKey = `${videoId}|${focusId ?? ''}|${query.trim()}|${collapsedSig}`
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

  /**
   * 键盘导航 / 搜索跳转 / 新增节点后，把选中节点带回视野。
   *
   * 两条克制：
   *   1. **已经在视野里就一动不动**——新增节点时父节点本来就点在上面，
   *      此时再 setCenter 只会让画面莫名其妙地平移一下；
   *   2. **不改缩放**。以前这里写的是 `zoom: Math.max(getZoom(), 0.75)`，
   *      用户把图画小看清全貌之后按一下方向键，画面会突然放大到 0.75，
   *      同样是「重置」的体感。要看大可以滚轮，该由用户自己决定。
   */
  useEffect(() => {
    if (!revealTick || !selectedId) return
    const n = layout.nodes.find((x) => x.id === selectedId)
    const box = wrapRef.current
    if (!n || !box) return
    const p = flowToScreenPosition({ x: n.x + n.width / 2, y: n.y + n.height / 2 })
    const r = box.getBoundingClientRect()
    const m = 48
    const visible = p.x > r.left + m && p.x < r.right - m && p.y > r.top + m && p.y < r.bottom - m
    if (visible) return
    setCenter(n.x + n.width / 2, n.y + n.height / 2, { zoom: getZoom(), duration: 220 })
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
