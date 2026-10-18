import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Segment } from '../types'
import { formatTs } from '../lib/format'
import { MIN_TAPPABLE } from './icons'

interface Props {
  segments: Segment[]
  currentTime: number
  onSeek: (t: number) => void
}

export default function Transcript({ segments, currentTime, onSeek }: Props) {
  /**
   * 默认**展开**（2026-10-18 用户要求）。
   *
   * 之前默认收起，只给一行「展开逐字稿（468 段）」——切到这个 tab 还要再点一次，
   * 而且收起态下「跟随播放滚动」也不生效。既然用户主动切过来了，就是要看内容。
   * 段数多的长视频确实会长，但这里是独立滚动区，不影响其它面板。
   */
  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const activeRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return segments
    return segments.filter((s) => s.text.toLowerCase().includes(q))
  }, [segments, query])

  const activeIdx = useMemo(() => {
    // 二分查找最后一个 start <= currentTime 的片段
    let lo = 0
    let hi = filtered.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (filtered[mid].start <= currentTime) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }, [filtered, currentTime])

  // 跟随播放进度滚动。用户手动滚动时暂停跟随，避免「抢滚动条」的糟糕体验。
  useEffect(() => {
    if (!autoScroll || collapsed) return
    const el = activeRef.current
    const box = containerRef.current
    if (!el || !box) return
    const top = el.offsetTop - box.offsetTop
    box.scrollTo({ top: top - box.clientHeight / 2, behavior: 'smooth' })
  }, [activeIdx, autoScroll, collapsed])

  const onScroll = () => {
    // 简单的「用户手动滚动即关闭跟随」：任何滚动事件后 2 秒内不再自动滚动
    setAutoScroll(false)
    const t = setTimeout(() => setAutoScroll(true), 2500)
    return () => clearTimeout(t)
  }

  if (segments.length === 0) {
    return <div className="text-sm text-gray-400 px-3 py-6 text-center">暂无转写内容。</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-1 pb-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={`text-xs text-blue-600 hover:text-blue-800 font-medium px-1.5 rounded hover:bg-blue-50 ${MIN_TAPPABLE}`}
        >
          {collapsed ? `展开逐字稿（${segments.length} 段）` : '收起'}
        </button>
        {!collapsed && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索内容…"
            className="ml-auto text-xs border border-gray-300 rounded px-2 py-1 w-40 focus:outline-none focus:border-blue-400"
          />
        )}
      </div>

      {!collapsed && (
        <div
          ref={containerRef}
          onScroll={onScroll}
          // flex-1 + min-h-0：吃满右侧面板的剩余高度。
          // 原来还写死 maxHeight:420，面板一高下面就空出一块，白瞎了空间。
          className="flex-1 min-h-0 overflow-y-auto thin-scroll space-y-0.5 pr-1"
        >
          {filtered.map((s, i) => {
            const active = i === activeIdx
            return (
              <TranscriptRow
                key={i}
                seg={s}
                active={active}
                query={query}
                onSeek={onSeek}
                innerRef={active ? activeRef : undefined}
              />
            )
          })}
          {filtered.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-4">没有匹配的片段</div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 一行逐字稿。
 *
 * **为什么要 memo**：逐字稿默认展开后，一小时视频有近三千段。播放时
 * currentTime 每 250ms 变一次，父组件跟着重渲染——不 memo 的话每次都要
 * 重新协调三千个节点，滚动和播放一起卡。memo 之后每次只有「上一句/当前句」
 * 这两行真的变。
 */
const TranscriptRow = memo(function TranscriptRow({
  seg,
  active,
  query,
  onSeek,
  innerRef,
}: {
  seg: Segment
  active: boolean
  query: string
  onSeek: (t: number) => void
  innerRef?: React.RefObject<HTMLDivElement>
}) {
  return (
    <div
      ref={innerRef}
      onClick={() => onSeek(seg.start)}
      className={[
        'flex gap-2 px-2 py-1.5 rounded cursor-pointer text-[12.5px] leading-relaxed transition',
        active ? 'bg-amber-50 text-gray-900' : 'hover:bg-gray-50 text-gray-700',
      ].join(' ')}
    >
      <span
        className={[
          'tabular-nums font-mono text-[11px] shrink-0 mt-0.5',
          active ? 'text-amber-600 font-medium' : 'text-gray-400',
        ].join(' ')}
      >
        {formatTs(seg.start)}
      </span>
      <span className="min-w-0">{highlight(seg.text, query)}</span>
    </div>
  )
})

/** 把命中的关键词标黄。关键词来自用户输入，用 split 而非正则，天然免疫正则注入。 */
function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const target = q.toLowerCase()
  const parts: React.ReactNode[] = []
  let idx = 0
  let pos = lower.indexOf(target)
  let key = 0
  while (pos !== -1) {
    if (pos > idx) parts.push(text.slice(idx, pos))
    parts.push(
      <mark key={key++} className="bg-yellow-200 text-inherit rounded-sm px-0.5">
        {text.slice(pos, pos + q.length)}
      </mark>,
    )
    idx = pos + q.length
    pos = lower.indexOf(target, idx)
  }
  if (idx < text.length) parts.push(text.slice(idx))
  return parts
}
