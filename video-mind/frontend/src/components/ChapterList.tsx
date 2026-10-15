import type { Chapter } from '../types'
import { formatTs } from '../lib/format'

interface Props {
  chapters: Chapter[]
  currentTime: number
  /** 传 end 时播放器会在章节结束处自动暂停 */
  onSeek: (t: number, end?: number) => void
}

export default function ChapterList({ chapters, currentTime, onSeek }: Props) {
  if (chapters.length === 0) {
    return (
      <div className="text-sm text-gray-400 px-3 py-6 text-center">
        暂无章节。点击「开始分析」后生成。
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {chapters.map((c) => {
        const active = currentTime >= c.start && currentTime < c.end
        return (
          <div
            key={c.idx}
            onClick={() => onSeek(c.start, c.end)}
            className={[
              'rounded-lg border px-3 py-2.5 cursor-pointer transition',
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
                <div
                  className={[
                    'text-[13px] font-medium leading-snug',
                    active ? 'text-blue-900' : 'text-gray-900',
                  ].join(' ')}
                >
                  {c.title}
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
                <div className="text-[10px] text-gray-400 mt-1.5 tabular-nums">
                  {formatTs(c.start)} – {formatTs(c.end)}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
