import { useState } from 'react'
import type { Chapter } from '../types'
import { formatTs } from '../lib/format'
import { parseTimestamp } from '../lib/mindmapEdit'

interface Props {
  chapters: Chapter[]
  currentTime: number
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
 * 由导图节点生成的章节（source_node_id 非空）会标注来源，并提示
 * 「改导图节点的时间会覆盖这里的修改」：不说明的话用户会遇到
 * 「我明明改了，保存导图后又被改回去」的困惑。
 */
export default function ChapterList({
  chapters,
  currentTime,
  onSeek,
  onAdd,
  onPatch,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null)

  if (chapters.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 px-3 py-6 text-center">
        <p className="text-sm text-gray-400 mb-2">暂无章节</p>
        <button
          onClick={onAdd}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
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
              />
            </div>
          )
        }

        return (
          <div
            key={c.id}
            data-chapter-id={c.id}
            onClick={() => onSeek(c.start, c.end)}
            className={[
              'group rounded-lg border px-3 py-2.5 cursor-pointer transition',
              active
                ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-300'
                : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/40',
            ].join(' ')}
          >
            <div className="flex items-start gap-2">
              <span
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
                    className={[
                      'text-[13px] font-medium leading-snug flex-1 min-w-0',
                      active ? 'text-blue-900' : 'text-gray-900',
                    ].join(' ')}
                  >
                    {c.title}
                  </div>
                  {/* 编辑/删除只在悬停时出现：列表本身是「点一下就跳播」的热区，
                      常驻按钮会让人不敢点。 */}
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(c.id)
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-white hover:border-gray-300 hover:text-gray-800"
                    >
                      编辑
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const extra = fromNode ? '\n（该章节由导图节点生成，节点时间戳也会被清空）' : ''
                        if (!confirm(`删除章节「${c.title}」？${extra}`)) return
                        onDelete(c.id)
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-red-500 hover:bg-red-50 hover:border-red-200"
                    >
                      删除
                    </button>
                  </div>
                </div>

                {c.summary && (
                  <p className="text-[12px] text-gray-500 mt-1 leading-relaxed">{c.summary}</p>
                )}
                {c.key_points && c.key_points.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {c.key_points.map((p, i) => (
                      <li key={i} className="text-[12px] text-gray-600 flex gap-1.5">
                        <span className="text-blue-400 shrink-0">·</span>
                        <span className="leading-relaxed">{p}</span>
                      </li>
                    ))}
                  </ul>
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
            </div>
          </div>
        )
      })}

      <button
        onClick={onAdd}
        className="w-full text-[11px] py-1.5 rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700"
      >
        + 手工新增章节
      </button>
    </div>
  )
}

function ChapterEditor({
  chapter,
  currentTime,
  onSubmit,
  onCancel,
}: {
  chapter: Chapter
  currentTime: number
  onSubmit: (patch: Partial<Chapter>) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(chapter.title)
  const [summary, setSummary] = useState(chapter.summary)
  const [start, setStart] = useState(formatTs(chapter.start))
  const [end, setEnd] = useState(formatTs(chapter.end))

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
    <div className="rounded-lg border border-blue-300 bg-blue-50/40 px-3 py-2.5 space-y-1.5">
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
      <textarea
        value={summary}
        onChange={(ev) => setSummary(ev.target.value)}
        placeholder="摘要（可留空）"
        rows={2}
        className="w-full text-[12px] px-2 py-1 rounded border border-gray-300 bg-white outline-none focus:border-blue-400 resize-none"
      />
      <div className="flex items-center gap-1.5">
        <input
          value={start}
          onChange={(ev) => setStart(ev.target.value)}
          placeholder="起点 1:23 或 83"
          className="w-[110px] text-[11px] tabular-nums px-2 py-1 rounded border border-gray-300 bg-white outline-none focus:border-blue-400"
        />
        <span className="text-[11px] text-gray-400">–</span>
        <input
          value={end}
          onChange={(ev) => setEnd(ev.target.value)}
          placeholder="终点"
          className="w-[110px] text-[11px] tabular-nums px-2 py-1 rounded border border-gray-300 bg-white outline-none focus:border-blue-400"
        />
        <button
          onClick={() => setStart(formatTs(currentTime))}
          title="用当前播放时间作为起点"
          className="text-[10px] px-1.5 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50"
        >
          起点=当前
        </button>
        <button
          onClick={() => setEnd(formatTs(currentTime))}
          title="用当前播放时间作为终点"
          className="text-[10px] px-1.5 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50"
        >
          终点=当前
        </button>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          onClick={submit}
          className="text-[11px] px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-500"
        >
          保存
        </button>
        <button
          onClick={onCancel}
          className="text-[11px] px-2.5 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50"
        >
          取消
        </button>
      </div>
    </div>
  )
}
