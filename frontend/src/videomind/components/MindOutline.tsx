import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import {
  withAlpha,
  type EditingTarget,
  type LaidOutNode,
  type LayoutResult,
  type MindViewActions,
} from '../lib/mindmapLayout'
import { formatTs } from '../lib/format'
import { splitHighlight } from '../lib/highlight'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  IconButton,
  MemoIcon,
  MIN_TAPPABLE,
  PlayIcon,
} from './icons'
import TimeRangeEditor from './TimeRangeEditor'

/**
 * 大纲视图：同一棵树的文本皮。
 *
 * XMind / 幕布都提供「导图 ⇄ 大纲」一键切换，原因很实在——
 * 校对层级关系、批量扫一遍章节标题时，缩进列表比画布快得多；
 * 而把握整体结构时画布又比列表直观。两个视图共用一套折叠/选中/编辑状态，
 * 切换时不丢上下文。
 */
export interface OutlineProps {
  /** 布局由容器统一算好传进来：画布与大纲共用同一次布局结果，避免重复计算 */
  layout: LayoutResult
  selectedId: string | null
  activeId: string | null
  matches: ReadonlySet<string>
  query: string
  currentTime: number
  editing: EditingTarget
  /** 编辑模式开关。浏览模式下只读，与画布视图共用同一个开关 */
  editable: boolean
  /** 节点 id → 跳转秒数（分类节点向下找第一个有时间的后代） */
  seekTimeOf?: ReadonlyMap<string, number | null>
  /** 是否在标题下铺出 1-2 句摘要。关掉就是一份紧凑的纯层级清单 */
  showSummary?: boolean
  actions: MindViewActions
}

export default function MindOutline(props: OutlineProps) {
  const { layout, selectedId, activeId, matches, query, editable, showSummary = true } = props

  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout])
  const coarseTime = Math.floor(props.currentTime)

  const activeRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // 播放到屏幕外、或搜索跳转到屏幕外的行时自动滚回来，
  // 否则会以为「导图没跟着走」或者「搜到了但没反应」
  useEffect(() => {
    const el = activeRef.current
    const box = boxRef.current
    if (!el || !box) return
    const top = el.offsetTop - box.offsetTop
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) {
      box.scrollTo({ top: top - box.clientHeight / 2, behavior: 'smooth' })
    }
  }, [activeId, selectedId])

  const dimming = query.trim().length > 0

  return (
    <div ref={boxRef} className="h-full overflow-y-auto thin-scroll pr-1">
      {layout.order.map((id) => {
        const n = byId.get(id)
        if (!n) return null
        return (
          <OutlineRow
            key={id}
            ref={n.id === (selectedId ?? activeId) ? activeRef : null}
            node={n}
            active={n.id === activeId}
            selected={n.id === selectedId}
            matched={dimming && matches.has(id)}
            dimmed={dimming && !matches.has(id)}
            query={query}
            currentTime={coarseTime}
            editing={props.editing}
            editable={editable}
            showSummary={showSummary}
            seekStart={props.seekTimeOf?.get(n.id) ?? n.start}
            actions={props.actions}
          />
        )
      })}
      {layout.order.length === 0 && (
        <div className="text-xs text-gray-400 text-center py-8">没有可见节点</div>
      )}
    </div>
  )
}

interface RowProps {
  node: LaidOutNode
  active: boolean
  selected: boolean
  matched: boolean
  dimmed: boolean
  query: string
  currentTime: number
  editing: EditingTarget
  editable: boolean
  /** 是否在标题下铺出摘要；关掉后每行只有一行，扫层级更快 */
  showSummary: boolean
  /** 点击该行要跳到的秒数；分类节点取第一个有时间的后代 */
  seekStart: number | null
  actions: MindViewActions
}

const OutlineRow = forwardRef<HTMLDivElement, RowProps>(function OutlineRow(
  {
    node,
    active,
    selected,
    matched,
    dimmed,
    query,
    currentTime,
    editing,
    editable,
    showSummary,
    seekStart,
    actions,
  },
  ref,
) {
  const isEditing = editing && editing.id === node.id ? editing : null
  const [labelDraft, setLabelDraft] = useState(node.label)

  // 进入编辑态时用树里的真实值重置草稿：行组件是常驻的，
  // 不重置的话上一次编辑留下的旧值会一直显示在输入框里。
  // 时间范围由 TimeRangeEditor 自己持草稿（两个输入框各有各的值）。
  useEffect(() => {
    if (!isEditing) return
    if (isEditing.field === 'label') setLabelDraft(node.label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing?.id, isEditing?.field, node.id])

  const submitLabel = () => {
    actions.commitLabel(node.id, labelDraft.trim())
    actions.cancelEdit()
  }

  const bg = matched ? '#fef9c3' : active ? '#fffbeb' : selected ? '#f1f5f9' : 'transparent'

  /**
   * 时间徽章：有终点就显示「起–止」，只有起点就显示起点。
   * 有子节点的节点，时间是子节点算出来的；若下面的叶子都还没设时间，
   * 显示「—」而不是「设时间」——那个位置本来就不接受手填。
   * 笔记节点显示「笔记」：它不在时间轴上，写「设时间」是骗人去点。
   */
  const rangeText = node.note
    ? '笔记'
    : node.timedChildren
      ? node.start === null
        ? '—'
        : node.end !== null
          ? `${formatTs(node.start)}–${formatTs(node.end)}`
          : formatTs(node.start)
      : node.start === null
        ? '设时间'
        : node.end !== null
          ? `${formatTs(node.start)}–${formatTs(node.end)}`
          : formatTs(node.start)

  const summary = showSummary && node.summary ? node.summary : ''

  return (
    <div
      ref={ref}
      // data-node-id 给冒烟脚本与调试用：大纲行没有稳定的选择器时，
      // 只能靠文本匹配，节点一改名脚本就找不到人了
      data-node-id={node.id}
      onClick={() => {
        if (isEditing) return
        actions.select(node.id)
        if (seekStart !== null) actions.seek(seekStart)
      }}
      onDoubleClick={() => {
        if (isEditing) return
        // 只读模式下双击 = 再跳一次；突然弹出输入框会让人以为误触改了内容
        if (editable) actions.beginEdit(node.id, 'label')
        else if (seekStart !== null) actions.seek(seekStart)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        actions.select(node.id)
        actions.openMenu(node.id, e.clientX, e.clientY)
      }}
      className="rounded px-1 py-0.5 cursor-pointer transition-colors"
      style={{
        paddingLeft: 4 + node.depth * 16,
        background: bg,
        opacity: dimmed ? 0.4 : 1,
        outline: selected ? '1.5px solid #1e293b' : 'none',
        outlineOffset: -1,
      }}
    >
      <div className="flex items-center gap-1.5">
        {/*
          折叠三角。没有子节点的行留等宽占位，保证文字左边缘对齐成一条线。
          占位宽度就是按钮的 24px——之前是 14px 宽的字符三角，
          点中的面积只有 14×9，鼠标要瞄着点，触控屏基本点不中。
        */}
        <span className="shrink-0 flex items-center justify-center" style={{ width: 24 }}>
          {node.hasChildren ? (
            <IconButton
              icon={node.collapsed ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
              label={node.collapsed ? '展开' : '折叠'}
              onClick={(e) => {
                e.stopPropagation()
                actions.toggleCollapse(node.id)
              }}
              className="hover:bg-gray-100"
            />
          ) : null}
        </span>

        <span
          className="shrink-0 rounded-full"
          style={{
            width: 8,
            height: 8,
            background: node.color,
            boxShadow: node.depth === 0 ? `0 0 0 2px ${withAlpha(node.color, 0.25)}` : 'none',
          }}
        />

        {isEditing?.field === 'label' ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={submitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLabel()
              if (e.key === 'Escape') actions.cancelEdit()
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 text-[12.5px] px-1 py-0.5 rounded bg-white text-gray-900 outline-none"
            style={{ border: '1px solid #60a5fa' }}
          />
        ) : (
          <span
            className={[
              'flex-1 min-w-0 truncate text-[12.5px] leading-relaxed',
              node.depth === 0 ? 'font-semibold text-gray-900' : 'text-gray-700',
            ].join(' ')}
            style={node.depth === 1 ? { color: node.color } : undefined}
          >
            {node.depth === 0 && active ? <PlayIcon size={10} className="mr-1 inline-block" /> : ''}
            {renderLabel(node.label, query)}
            {node.collapsed && node.hiddenCount > 0 && (
              <span className="ml-1 text-[10px] text-gray-400 tabular-nums">
                +{node.hiddenCount}
              </span>
            )}
          </span>
        )}

        {/* 有 Markdown 笔记的节点挂个小本子图标：一眼看出哪些节点有内容可读 */}
        {node.hasNote && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              actions.openNote(node.id)
            }}
            title="这个节点有笔记（Markdown）｜点击查看"
            aria-label={`查看节点「${node.label}」的笔记`}
            data-role="note-mark"
            className="nodrag shrink-0 inline-flex items-center justify-center h-4 w-4 rounded text-amber-600 hover:bg-amber-50"
          >
            <MemoIcon size={11} />
          </button>
        )}

        {isEditing?.field === 'time' ? (
          <button
            onClick={(e) => e.stopPropagation()}
            className="nodrag shrink-0 tabular-nums text-[10px] px-1 rounded hover:bg-black/5"
            style={{ color: '#64748b' }}
          >
            编辑中…
          </button>
        ) : (
          // 时间徽章：叶子可改；有子节点的节点只展示（时间由子节点算出来）；
          // 笔记节点显示「笔记」，点了什么都不做
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (node.note) return
              // 有子节点的节点时间不可改，点它就当「跳到这一段的开头」
              if (!editable || node.timedChildren) {
                if (node.start !== null) actions.seek(node.start)
                return
              }
              actions.beginEdit(node.id, 'time')
            }}
            title={
              node.note
                ? '笔记节点没有时间范围（也不影响父节点的时间范围）'
                : node.timedChildren
                  ? `时间范围由子节点决定（起点取最早、终点取最晚）：${rangeText}｜点击跳到此处`
                  : editable
                    ? '设置/修改开始与结束时间'
                    : node.start !== null
                      ? `跳转到 ${rangeText}（只读模式不可修改）`
                      : '该节点还没有设置时间范围'
            }
            data-role="time-badge"
            className={`nodrag shrink-0 tabular-nums text-[10px] px-1 rounded hover:bg-black/5 ${MIN_TAPPABLE}`}
            style={{ color: node.note ? '#b45309' : node.start === null ? '#cbd5e1' : '#64748b' }}
          >
            {rangeText}
          </button>
        )}
      </div>

      {/* 起止两个输入框铺在行下方：挤在标题右边会把标题压得提前截断，
          也会和时间徽章抢位置 */}
      {isEditing?.field === 'time' && (
        <div className="pb-1" style={{ paddingLeft: 44 }}>
          <TimeRangeEditor
            start={node.start}
            end={node.end}
            currentTime={currentTime}
            onSubmit={(s, e) => {
              actions.commitRange(node.id, s, e)
              actions.cancelEdit()
            }}
            onCancel={() => actions.cancelEdit()}
          />
        </div>
      )}

      {/*
        摘要另起一行，和标题左边缘对齐
        （缩进量 = 三角 24 + 间距 6 + 圆点 8 + 间距 6）。
        铺在标题右边会和徽章抢位置，还会把标题挤到提前截断。
      */}
      {summary && (
        <div
          className="text-[10.5px] leading-snug text-gray-400 pt-0.5 pr-1"
          style={{ paddingLeft: 44 }}
        >
          {summary}
        </div>
      )}
    </div>
  )
})

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
