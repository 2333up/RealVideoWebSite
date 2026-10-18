import { useEffect, useRef, useState } from 'react'
import type { Chapter, MindMapNode } from '../types'
import { formatTs } from '../lib/format'
import { parseTimestamp } from '../lib/mindmapEdit'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MIN_TAPPABLE,
  PencilIcon,
  TrashIcon,
} from './icons'

interface Props {
  chapters: Chapter[]
  currentTime: number
  /** 整棵导图：用来在每一章下面铺出「这一章包含哪些节点」的树 */
  mindmap: MindMapNode | null
  /** 传 end 时播放器会在章节结束处自动暂停 */
  onSeek: (t: number, end?: number) => void
  onAdd: () => void
  onPatch: (chapterId: number, patch: Partial<Chapter>) => void
  onDelete: (chapterId: number) => void
}

/**
 * 章节列表。
 *
 * 每条都能就地编辑——LLM 的分章不完美，与其反复调 prompt，
 * 不如把「改一下」这件事直接交给用户。
 *
 * 2026-10-18 起每张章节卡本身是一棵树：卡里铺出「这一章包含的导图节点」，
 * 逐层可折叠。它和大纲里的节点一一对应，但比大纲详细——大纲只给 label 和
 * 一两句摘要，这里还给该节点时间范围内的**原文**（逐字稿切片）。
 *
 * 由导图节点生成的章节（source_node_id 非空）会标注来源，并提示
 * 「改导图节点的时间会覆盖这里的修改」：不说明的话用户会遇到
 * 「我明明改了，保存导图后又被改回去」的困惑。
 */
export default function ChapterList({
  chapters,
  currentTime,
  mindmap,
  onSeek,
  onAdd,
  onPatch,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null)
  /** 哪些章节卡是收起的。默认全展开——用户要的就是「看细节」 */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const toggleCard = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (chapters.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 px-3 py-6 text-center">
        <p className="text-sm text-gray-400 mb-2">暂无章节</p>
        <button
          onClick={onAdd}
          className={`text-xs px-3 rounded border border-gray-300 hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          手工新增一章
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {chapters.map((c) => {
        const active = currentTime >= c.start && currentTime < c.end
        const fromNode = c.source_node_id !== null
        const open = !collapsed.has(c.id)
        // 这一章包含哪些导图节点：从根的子节点开始挑，根节点自己不进任何一章
        const items = mindmap ? pickForChapter(mindmap, c.start, c.end) : []

        if (editingId === c.id) {
          return (
            // data-chapter-id 是滚动定位的锚点：编辑态也要保留，
            // 否则切到编辑那一瞬间锚点消失，联动滚不动
            <div key={c.id} data-chapter-id={c.id}>
                <ChapterEditor
                  key={c.id}
                  chapter={c}
                  currentTime={currentTime}
                  onCancel={() => setEditingId(null)}
                  onSubmit={(patch) => {
                    onPatch(c.id, patch)
                    setEditingId(null)
                  }}
                  onDelete={() => {
                    const extra = fromNode
                      ? '\n（该章节由导图节点生成，节点时间戳也会被清空）'
                      : ''
                    if (!confirm(`删除章节「${c.title}」？${extra}`)) return
                    onDelete(c.id)
                    setEditingId(null)
                  }}
                />
            </div>
          )
        }

        return (
          <div
            key={c.id}
            data-chapter-id={c.id}
            className={[
              // py-2 而不是 2.5：一屏能多看到半条章节，少滚一次
              'group rounded-lg border px-2.5 py-2 transition',
              active
                ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-300'
                : 'border-gray-200 bg-white hover:border-blue-300',
            ].join(' ')}
          >
            {/* 卡头：点它 = 播这一章；左边的三角只管折叠，不跳播 */}
            <div
              className="flex items-start gap-1.5 cursor-pointer"
              onClick={() => onSeek(c.start, c.end)}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCard(c.id)
                }}
                aria-label={open ? `收起章节「${c.title}」` : `展开章节「${c.title}」`}
                aria-expanded={open}
                title={open ? '收起这一章' : '展开这一章'}
                className="shrink-0 -ml-0.5 mt-0.5 text-gray-400 hover:text-gray-700"
              >
                {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
              </button>

              <span
                // 自动化钩子：卡里现在还有节点树，整卡 innerText 不再等于「章节本身」，
                // 脚本要单独认这两个位置（probe-time-sync 靠它判断章节边界没被动过）
                data-role="chapter-badge"
                className={[
                  'text-[11px] tabular-nums font-mono px-1.5 py-0.5 rounded shrink-0 mt-0.5',
                  active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600',
                ].join(' ')}
              >
                {formatTs(c.start)}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  <div
                    data-role="chapter-title"
                    className={[
                      'text-[13px] font-medium leading-snug flex-1 min-w-0',
                      active ? 'text-blue-900' : 'text-gray-900',
                    ].join(' ')}
                  >
                    {c.title}
                  </div>
                  {/* 编辑只在悬停时出现：列表本身是「点一下就跳播」的热区，
                      常驻按钮会让人不敢点。
                      删除**不放在这里**——它和「改一下」不是同一量级的操作，
                      摆在一起容易手滑点错；收进编辑面板里，想删的人自然会找到，
                      只想改内容的人不会被它吓到。 */}
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(c.id)
                      }}
                      title="编辑这条章节（删除也在里面）"
                      className={`gap-1 text-[10px] px-1.5 rounded border border-gray-200 text-gray-500 hover:bg-white hover:border-gray-300 hover:text-gray-800 ${MIN_TAPPABLE}`}
                    >
                      <PencilIcon size={12} />
                      编辑
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {open && (
              <div className="mt-1 pl-[22px]">
                {/* 摘要默认两行：章节卡是「扫一眼找位置」用的，全铺开一屏只放得下两条。
                    被裁掉的时候必须给出「展开全文」——只裁不给出口，
                    等于把内容锁死给人看（2026-10-18 用户反馈）。 */}
                {c.summary && <ClampedSummary text={c.summary} />}

                {c.key_points && c.key_points.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {c.key_points.map((p, i) => (
                      <li key={i} className="text-[12px] text-gray-600 flex gap-1.5">
                        <span className="text-blue-400 shrink-0">·</span>
                        <span className="leading-relaxed">{p}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* 这一章的节点树：和大纲里的节点一一对应，但每一行还带原文 */}
                {items.length > 0 ? (
                  <div className="mt-1.5 border-t border-gray-100 pt-1">
                    <NodeTree items={items} onSeek={onSeek} />
                  </div>
                ) : (
                  mindmap && (
                    <p className="mt-1.5 text-[10px] text-gray-300">
                      这一章没有对应的导图节点
                    </p>
                  )
                )}

                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-gray-400 tabular-nums">
                    {formatTs(c.start)} – {formatTs(c.end)}
                  </span>
                  {fromNode && (
                    <span className="text-[10px] text-gray-400" title="由导图节点的时间戳驱动">
                      · 来自导图节点（改节点时间会覆盖此处）
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}

      <button
        onClick={onAdd}
        className={`w-full text-[11px] rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700 ${MIN_TAPPABLE}`}
      >
        + 手工新增章节
      </button>
    </div>
  )
}

// ------------------------------------------------------------------ 章节里的节点树

interface TreeItem {
  node: MindMapNode
  children: TreeItem[]
}

/**
 * 挑出「落在这一章里」的节点子树。
 *
 * 判定用节点自己的起点：起点落在 [start, end) 就算属于这一章。
 * 从**根的子节点**开始挑，根节点自己永远不进任何一章——它是整支视频。
 * 父节点只有后代落进来才会被带上（作为容器），避免把整棵大树塞进第一章。
 */
function pickForChapter(root: MindMapNode, start: number, end: number): TreeItem[] {
  const pick = (node: MindMapNode): TreeItem | null => {
    const kids = (node.children ?? [])
      .map((k) => pick(k))
      .filter((x): x is TreeItem => x !== null)
    const s = node.start
    const inside = s !== null && s !== undefined && s >= start - 0.01 && s < end - 0.01
    if (!inside && kids.length === 0) return null
    return { node, children: kids }
  }
  return (root.children ?? [])
    .map((k) => pick(k))
    .filter((x): x is TreeItem => x !== null)
}

function NodeTree({
  items,
  onSeek,
}: {
  items: TreeItem[]
  onSeek: (t: number, end?: number) => void
}) {
  return (
    <div className="space-y-0.5">
      {items.map((it, i) => (
        <NodeRow
          key={it.node.id ?? `n${i}`}
          item={it}
          depth={0}
          onSeek={onSeek}
        />
      ))}
    </div>
  )
}

/**
 * 一个节点一行：时间 + 标题 + 摘要，点标题跳播。
 *
 * 这里**不放原文**（2026-10-18 用户反馈「太细碎」）：逐字稿整段就在右栏，
 * 章节树再把每段原文摊一遍，不但把一屏撑成几十行，还会把「扫一眼找位置」
 * 这个主要用途彻底稀释掉。要看原文去右栏的「逐字稿」。
 */
function NodeRow({
  item,
  depth,
  onSeek,
}: {
  item: TreeItem
  depth: number
  onSeek: (t: number, end?: number) => void
}) {
  const [open, setOpen] = useState(true)
  const node = item.node
  const hasKids = item.children.length > 0
  const t = node.start
  const canSeek = t !== null && t !== undefined

  return (
    <div>
      <div className="flex items-start gap-1">
        {/* 折叠三角：没有子节点时留一个等宽占位，让同级的时间对齐 */}
        {hasKids ? (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? '收起子节点' : '展开子节点'}
            aria-expanded={open}
            className="shrink-0 mt-[3px] text-gray-300 hover:text-gray-600"
          >
            {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </button>
        ) : (
          <span className="shrink-0 w-3" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            {canSeek && (
              <span className="text-[10px] tabular-nums text-gray-400 shrink-0 mt-[1px]">
                {formatTs(t as number)}
              </span>
            )}
            <button
              onClick={() => canSeek && onSeek(t as number, node.end ?? undefined)}
              title={canSeek ? `跳到 ${formatTs(t as number)}` : node.label}
              className={[
                'text-left text-[12px] leading-snug min-w-0',
                canSeek ? 'text-gray-800 hover:text-blue-700 hover:underline' : 'text-gray-800',
              ].join(' ')}
            >
              {node.label}
            </button>
          </div>

          {node.summary && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">{node.summary}</p>
          )}

        </div>
      </div>

      {open && hasKids && (
        <div className="ml-[11px] pl-1.5 border-l border-gray-100">
          {item.children.map((k, i) => (
            <NodeRow
              key={k.node.id ?? `${i}`}
              item={k}
              depth={depth + 1}
              onSeek={onSeek}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 章节摘要：默认两行，放不下时给一个「展开全文 / 收起」。
 *
 * 两个细节值得说：
 *  1. **只在真的被裁时才显示按钮**。直接用文本长度猜是猜不准的——左栏宽度可拖，
 *     同一个摘要 200px 宽和 400px 宽差好几行。所以拿 scrollHeight 和 clientHeight 量。
 *  2. **按钮必须 stopPropagation**。整张卡片是「点一下就跳播」的热区，
 *     不拦的话点「展开」会顺带把视频跳走。
 */
function ClampedSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      // 展开之后 scrollHeight 恒等于 clientHeight，量了也没意义，
      // 此时保留上一次的结论即可（否则「收起」按钮会自己消失）
      if (expanded) return
      setOverflowing(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    // 左栏可以拖宽拖窄，收起态下宽度一变，裁不裁得到就变了
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  return (
    <>
      <p
        ref={ref}
        className={[
          'mt-0.5 text-[12px] leading-relaxed text-gray-500',
          expanded ? '' : 'line-clamp-2',
        ].join(' ')}
      >
        {text}
      </p>
      {(overflowing || expanded) && (
        <button
          onClick={(e) => {
            // 别让「展开」顺带触发整卡的跳播
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          title={expanded ? '收起摘要' : '展开看完整摘要'}
          className={`mt-0.5 text-[11px] text-blue-600 hover:text-blue-700 hover:underline ${MIN_TAPPABLE}`}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </>
  )
}

function ChapterEditor({  chapter,
  currentTime,
  onSubmit,
  onCancel,
  onDelete,
}: {
  chapter: Chapter
  currentTime: number
  onSubmit: (patch: Partial<Chapter>) => void
  onCancel: () => void
  /** 删除收在编辑面板里：和「改一下」分开摆，手滑点错的概率小得多 */
  onDelete: () => void
}) {
  const [title, setTitle] = useState(chapter.title)
  const [summary, setSummary] = useState(chapter.summary)
  const [start, setStart] = useState(formatTs(chapter.start))
  const [end, setEnd] = useState(formatTs(chapter.end))

  /**
   * 摘要框随内容长高。
   *
   * 之前写死 rows={2}：一段五行的摘要只能看到两行，剩下的要靠框内滚动条翻——
   * 在一张已经展开的卡片里再套一个滚动区，读起来像用钥匙孔看风景。
   * 现在高度跟着 scrollHeight 走，最多到视口的 45%（再高就自己滚，
   * 免得一次编辑把整页顶飞）。
   */
  const summaryRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = summaryRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [summary])

  const submit = () => {
    const s = parseTimestamp(start)
    const e = parseTimestamp(end)
    if (s === null || e === null) {
      alert('时间格式不对。可以填秒数（83）或 1:23 这样的写法。')
      return
    }
    if (e <= s) {
      alert('结束时间必须晚于开始时间。')
      return
    }
    onSubmit({ title: title.trim() || chapter.title, summary, start: s, end: e })
  }

  return (
    // px-2 而不是 px-3：编辑时每一像素都该让给输入框
    <div className="rounded-lg border border-blue-300 bg-blue-50/40 px-2 py-2 space-y-1.5">
      <input
        autoFocus
        value={title}
        onChange={(ev) => setTitle(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') submit()
          if (ev.key === 'Escape') onCancel()
        }}
        placeholder="章节标题"
        className="w-full text-[13px] font-medium px-2 py-1 rounded border border-gray-300 bg-white outline-none focus:border-blue-400"
      />
      {/* 摘要：跟着内容长高（见上面的 summaryRef），最多到视口 45% 再滚动 */}
      <textarea
        ref={summaryRef}
        value={summary}
        onChange={(ev) => setSummary(ev.target.value)}
        placeholder="摘要（可留空）"
        rows={3}
        className="w-full min-h-[64px] max-h-[45vh] text-[12px] leading-relaxed px-2 py-1.5 rounded border border-gray-300 bg-white outline-none focus:border-blue-400 resize-none overflow-y-auto thin-scroll"
      />
      {/* 起止：输入框吃掉整行宽度，两个「=当前」跟在后面 */}
      <div className="flex items-center gap-1">
        <input
          value={start}
          onChange={(ev) => setStart(ev.target.value)}
          placeholder="起点 1:23 或 83"
          className="flex-1 min-w-0 text-[11px] tabular-nums px-2 py-1 rounded border border-gray-300 bg-white outline-none focus:border-blue-400"
        />
        <span className="text-[11px] text-gray-400 shrink-0">–</span>
        <input
          value={end}
          onChange={(ev) => setEnd(ev.target.value)}
          placeholder="终点"
          className="flex-1 min-w-0 text-[11px] tabular-nums px-2 py-1 rounded border border-gray-300 bg-white outline-none focus:border-blue-400"
        />
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setStart(formatTs(currentTime))}
          title="用当前播放时间作为起点"
          className={`flex-1 text-[10px] px-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          起点=当前
        </button>
        <button
          onClick={() => setEnd(formatTs(currentTime))}
          title="用当前播放时间作为终点"
          className={`flex-1 text-[10px] px-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          终点=当前
        </button>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          onClick={submit}
          className={`text-[11px] px-2.5 rounded bg-blue-600 text-white hover:bg-blue-500 ${MIN_TAPPABLE}`}
        >
          保存
        </button>
        <button
          onClick={onCancel}
          className={`text-[11px] px-2.5 rounded border border-gray-300 bg-white hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          取消
        </button>
        {/* 删除推到最右：和「保存 / 取消」隔开一段距离，
            视觉上就不属于同一组操作，误触的概率更低 */}
        <span className="flex-1" />
        <button
          onClick={onDelete}
          className={`gap-1 text-[11px] px-2.5 rounded border border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300 ${MIN_TAPPABLE}`}
        >
          <TrashIcon size={13} />
          删除本章节
        </button>
      </div>
    </div>
  )
}
