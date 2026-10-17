import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import {
  withAlpha,
  type EditingTarget,
  type LaidOutNode,
  type LayoutResult,
  type MindViewActions,
} from '../lib/mindmapLayout'
import { formatTs } from '../lib/format'
import { parseTimestamp } from '../lib/mindmapEdit'
import { splitHighlight } from '../lib/highlight'

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
  actions: MindViewActions
}

export default function MindOutline(props: OutlineProps) {
  const { layout, selectedId, activeId, matches, query, editable } = props

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
  /** 点击该行要跳到的秒数；分类节点取第一个有时间的后代 */
  seekStart: number | null
  actions: MindViewActions
}

const OutlineRow = forwardRef<HTMLDivElement, RowProps>(function OutlineRow(
  { node, active, selected, matched, dimmed, query, currentTime, editing, editable, seekStart, actions },
  ref,
) {
  const isEditing = editing && editing.id === node.id ? editing : null
  const [labelDraft, setLabelDraft] = useState(node.label)
  const [timeDraft, setTimeDraft] = useState(node.start === null ? '' : formatTs(node.start))

  // 进入编辑态时用树里的真实值重置草稿：行组件是常驻的，
  // 不重置的话上一次编辑留下的旧值会一直显示在输入框里。
  useEffect(() => {
    if (!isEditing) return
    if (isEditing.field === 'label') setLabelDraft(node.label)
    else setTimeDraft(node.start === null ? '' : formatTs(node.start))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing?.id, isEditing?.field, node.id])

  const submitLabel = () => {
    actions.commitLabel(node.id, labelDraft.trim())
    actions.cancelEdit()
  }
  const submitTime = () => {
    const text = timeDraft.trim()
    if (!text) {
      actions.commitTime(node.id, null)
    } else {
      const seconds = parseTimestamp(text)
      if (seconds === null) return
      actions.commitTime(node.id, seconds)
    }
    actions.cancelEdit()
  }

  const bg = matched ? '#fef9c3' : active ? '#fffbeb' : selected ? '#f1f5f9' : 'transparent'

  return (
    <div
      ref={ref}
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
      className="flex items-center gap-1.5 rounded px-1 py-1 cursor-pointer transition-colors"
      style={{
        paddingLeft: 4 + node.depth * 16,
        background: bg,
        opacity: dimmed ? 0.4 : 1,
        outline: selected ? '1.5px solid #1e293b' : 'none',
        outlineOffset: -1,
      }}
    >
      {/* 折叠三角。没有子节点的行留等宽占位，保证文字左边缘对齐成一条线 */}
      <span className="shrink-0" style={{ width: 14 }}>
        {node.hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              actions.toggleCollapse(node.id)
            }}
            title={node.collapsed ? '展开' : '折叠'}
            className="text-[9px] leading-none w-3.5 text-gray-400 hover:text-gray-800"
          >
            {node.collapsed ? '▶' : '▼'}
          </button>
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
          {node.depth === 0 && active ? '▶ ' : ''}
          {renderLabel(node.label, query)}
          {node.collapsed && node.hiddenCount > 0 && (
            <span className="ml-1 text-[10px] text-gray-400 tabular-nums">
              +{node.hiddenCount}
            </span>
          )}
        </span>
      )}

      {isEditing?.field === 'time' ? (
        <span className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={timeDraft}
            onChange={(e) => setTimeDraft(e.target.value)}
            onBlur={submitTime}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTime()
              if (e.key === 'Escape') actions.cancelEdit()
            }}
            placeholder="1:23"
            className="w-[60px] text-[11px] tabular-nums px-1 py-0.5 rounded bg-white text-gray-900 outline-none"
            style={{ border: '1px solid #60a5fa' }}
          />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTimeDraft(formatTs(currentTime))}
            title="填入当前播放时间"
            className="text-[10px] px-1 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
          >
            当前
          </button>
        </span>
      ) : node.hasChildren ? null : (
        // 分类节点不显示时间：它的时间就是第一个子节点的时间，
        // 显示出来会让大纲上下两行出现同一个时间戳
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!editable) {
              if (node.start !== null) actions.seek(node.start)
              return
            }
            actions.beginEdit(node.id, 'time')
          }}
          title={
            editable
              ? '设置/修改时间戳'
              : node.start !== null
                ? '跳转到该时间（只读模式不可修改）'
                : '该节点还没有设置时间戳'
          }
          className="nodrag shrink-0 tabular-nums text-[10px] px-1 rounded hover:bg-black/5"
          style={{ color: node.start === null ? '#cbd5e1' : '#64748b' }}
        >
          {node.start === null ? '设时间' : formatTs(node.start)}
        </button>
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
