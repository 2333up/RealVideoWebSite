import { useCallback, useEffect, useState } from 'react'
import { api, formatCount, formatRelativeTime, type CommentItem } from '../api/client'

interface Props {
  platform: string
  uid: string
  /** 评论是可选能力：平台不支持时上层可传 false 直接不渲染 */
  enabled?: boolean
}

const PAGE_SIZE = 20

/**
 * 评论区。
 *
 * 与详情页一样走「取结构化数据后自绘」的路线，
 * 因此不会夹带平台页面里的任何推荐内容。
 */
export default function CommentSection({ platform, uid, enabled = true }: Props) {
  const [items, setItems] = useState<CommentItem[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [sort, setSort] = useState<'hot' | 'time'>('hot')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)

  const load = useCallback(
    async (targetPage: number, targetSort: 'hot' | 'time', append: boolean) => {
      if (!enabled) return
      if (append) setLoadingMore(true)
      else setLoading(true)
      setError('')
      try {
        const res = await api.fetchComments(platform, uid, targetPage, PAGE_SIZE, targetSort)
        setItems((prev) => (append ? [...prev, ...res.items] : res.items))
        setTotal(res.total)
        setHasMore(res.has_more)
        setPage(res.page)
        setUnsupported(false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : '评论加载失败'
        // 平台未实现评论能力时静默不展示，而不是抛一个刺眼的错误
        if (msg.includes('暂不支持评论') || msg.includes('404')) {
          setUnsupported(true)
        } else {
          setError(msg)
        }
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [enabled, platform, uid],
  )

  // 首次加载 / 切换排序 / 换内容时重置
  useEffect(() => {
    if (!enabled) return
    void load(1, sort, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, sort, enabled])

  if (!enabled || unsupported) return null

  return (
    <section className="mt-5 border-t border-ink-100 pt-4">
      {/* 头部：标题 + 排序切换 */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ink-700">
          评论{total > 0 ? `（${formatCount(total)}）` : ''}
        </h3>
        <div className="flex rounded-lg bg-slate-100 p-0.5">
          {(
            [
              { key: 'hot', label: '最热' },
              { key: 'time', label: '最新' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setSort(opt.key)}
              className={`rounded-[7px] px-2.5 py-0.5 text-[11px] font-medium transition-all ${
                sort === opt.key
                  ? 'bg-white text-ink-900 shadow-sm'
                  : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-2.5">
              <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-slate-100" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
                <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">{error}</p>
      ) : items.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-ink-300">暂无评论</p>
      ) : (
        <>
          <ul className="max-h-[340px] space-y-3.5 overflow-y-auto pr-1">
            {items.map((c) => (
              <CommentRow key={c.id} comment={c} />
            ))}
          </ul>

          {hasMore ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void load(page + 1, sort, true)}
              className="btn-ghost mt-3 w-full !py-1.5 !text-[11px]"
            >
              {loadingMore ? '加载中…' : '查看更多评论'}
            </button>
          ) : (
            <p className="mt-3 text-center text-[11px] text-ink-300">已显示全部评论</p>
          )}
        </>
      )}
    </section>
  )
}

function CommentRow({ comment, nested = false }: { comment: CommentItem; nested?: boolean }) {
  return (
    <li className={nested ? 'mt-2 border-l-2 border-ink-100 pl-2.5' : ''}>
      <div className="flex gap-2.5">
        {comment.avatar ? (
          <img
            src={comment.avatar}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className={`${
              nested ? 'h-5 w-5' : 'h-7 w-7'
            } shrink-0 rounded-full object-cover ring-1 ring-ink-100`}
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
        ) : (
          <div
            className={`${
              nested ? 'h-5 w-5 text-[9px]' : 'h-7 w-7 text-[10px]'
            } flex shrink-0 items-center justify-center rounded-full bg-slate-100`}
          >
            👤
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`truncate font-medium text-ink-900 ${nested ? 'text-[11px]' : 'text-xs'}`}
            >
              {comment.author || '匿名用户'}
            </span>
            <span className="shrink-0 text-[10px] text-ink-300">
              {formatRelativeTime(comment.created_at)}
            </span>
          </div>

          <p
            className={`mt-0.5 whitespace-pre-wrap break-words leading-relaxed text-ink-700 ${
              nested ? 'text-[11px]' : 'text-xs'
            }`}
          >
            {comment.content}
          </p>

          <div className="mt-1 flex items-center gap-3 text-[10px] text-ink-300">
            {comment.like > 0 ? <span>👍 {formatCount(comment.like)}</span> : null}
            {comment.reply_count > 0 ? <span>{comment.reply_count} 条回复</span> : null}
          </div>
        </div>
      </div>

      {/* 楼中楼 */}
      {comment.replies.length > 0 ? (
        <ul>
          {comment.replies.map((sub) => (
            <CommentRow key={sub.id} comment={sub} nested />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
