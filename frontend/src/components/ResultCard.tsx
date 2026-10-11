import { useState } from 'react'
import type { ContentCard as CardData } from '../api/client'
import { IMG_PROPS, formatCount, formatDuration, formatRelativeTime } from '../api/client'

interface Props {
  item: CardData
  index: number
  accentColor: string
  /** 左键点击时在浮层内打开详情（而非跳走） */
  onOpen: (item: CardData) => void
}

/** 左键开浮层；Ctrl / Shift / 中键等保留浏览器新窗口打开的习惯 */
function interceptOpen(e: React.MouseEvent, open: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  e.preventDefault()
  open()
}

/**
 * 固定尺寸结果卡片：250 × 210。
 * 封面区 250×140（恰为 16:9），下方 70px 承载标题与元信息。
 * 卡片宽度恒定，由外层网格的 auto-fill 决定每行能放几列。
 */
export default function ResultCard({ item, index, accentColor, onOpen }: Props) {
  const [imageFailed, setImageFailed] = useState(false)
  const isVideo = item.kind === 'video'
  const openDetail = () => onOpen(item)

  return (
    <article
      className="animate-fade-up group flex h-[210px] w-[250px] flex-col overflow-hidden rounded-xl
                 border border-ink-100/80 bg-white shadow-card transition-all duration-200
                 hover:-translate-y-0.5 hover:border-ink-300/70 hover:shadow-lifted"
      style={{ animationDelay: `${Math.min(index, 24) * 22}ms` }}
    >
      {/* ---- 封面区 250 × 136 ---- */}
      <a
        href={item.page_url}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => interceptOpen(e, openDetail)}
        className="relative block h-[136px] w-full shrink-0 overflow-hidden bg-slate-100"
      >
        {imageFailed || !item.cover_url ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
            <span className="text-3xl opacity-40">{isVideo ? '🎬' : '📄'}</span>
          </div>
        ) : (
          <img
            {...IMG_PROPS}
            src={item.cover_url}
            alt={item.title}
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        )}

        {/* 内容形态角标 */}
        <span
          className="absolute left-1.5 top-1.5 rounded px-1.5 py-px text-[10px] font-semibold leading-[1.4] text-white shadow-sm"
          style={{ backgroundColor: isVideo ? accentColor : '#4B5563' }}
        >
          {isVideo ? '视频' : '图文'}
        </span>

        {/* 时长 / 图片数 */}
        {isVideo && item.duration ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/72 px-1 py-px text-[10px] font-medium tabular-nums leading-[1.4] text-white">
            {formatDuration(item.duration)}
          </span>
        ) : null}
        {!isVideo && item.extra?.image_count ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/72 px-1 py-px text-[10px] leading-[1.4] text-white">
            {String(item.extra.image_count)}图
          </span>
        ) : null}
      </a>

      {/* ---- 文字区 74px（210 - 136）----
           各区块高度已在 12px 字号下配平，确保标题有完整两行空间：
           padding 10 + 标题 32.4 + 作者行 12.5 + 间距 2 + 时间行 11.9 = 68.8 < 74 */}
      <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-1.5 pt-1">
        <a
          href={item.page_url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => interceptOpen(e, openDetail)}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <h3 className="line-clamp-2 text-[12px] font-medium leading-[1.35] text-ink-900 transition-colors group-hover:text-bilibili">
            {item.title}
          </h3>
        </a>

        {/* shrink-0：元信息行永不被压缩 */}
        <div className="mt-1 flex shrink-0 items-center gap-1 text-[10px] leading-[1.25] text-ink-500">
          <span className="max-w-[7.5rem] truncate">{item.author.name || '匿名'}</span>
          <span className="text-ink-300">·</span>
          <span className="tabular-nums">{formatCount(item.view_count)}播放</span>
        </div>

        <div className="mt-0.5 flex shrink-0 items-center gap-1 text-[9.5px] leading-[1.25] text-ink-300">
          <span>{formatRelativeTime(item.published_at)}</span>
          {item.comment_count > 0 ? (
            <>
              <span>·</span>
              <span className="tabular-nums">{formatCount(item.comment_count)}评论</span>
            </>
          ) : null}
        </div>
      </div>
    </article>
  )
}
