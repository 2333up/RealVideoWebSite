import { useCallback, useEffect, useRef, useState } from 'react'
import { api, formatCount, formatDuration, formatRelativeTime, type ContentCard } from '../api/client'
import CommentSection from './CommentSection'

interface Props {
  platform: string
  uid: string
  accentColor: string
  /** 列表里已有的简要信息，详情到达前先顶上，避免白屏 */
  fallback: ContentCard | null
  onClose: () => void
}

/**
 * 视频详情浮层。
 *
 * 屏蔽推荐的思路：不嵌入 www.bilibili.com 的视频页（那个页面通篇是推荐流），
 * 而是——
 *   1. 播放器只用官方 embed 域名 player.bilibili.com（无侧边推荐栏）
 *   2. 标题/UP主/数据/简介等全部由我们调接口后自行渲染
 * 于是推荐内容根本没有落脚点。
 */
export default function VideoDetailModal({ platform, uid, accentColor, fallback, onClose }: Props) {
  const [detail, setDetail] = useState<ContentCard | null>(fallback)
  const [loading, setLoading] = useState(!fallback)
  const [error, setError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // embed = 代理后的站方页面（自带评论区，已隐藏推荐）
  // clean = 播放器 + 我们自绘的详情与评论（无站方页面，最干净）
  const [viewMode, setViewMode] = useState<'embed' | 'clean'>('embed')
  // 过滤强度：站方推荐容器的真实类名无法从服务端推断，
  // 故提供逐级加强的按钮，让用户按实际效果推进
  const [filterLevel, setFilterLevel] = useState(0)
  // 已隐藏元素计数：由 iframe 内清扫脚本通过 __lingoseekStats 上报，用于确认净化是否真的生效
  const [hiddenCount, setHiddenCount] = useState(0)

  const isVideo = detail?.kind === 'video'
  const bvid = (detail?.extra?.bvid as string | undefined) ?? ''

  // 走服务端代理而非直接 iframe 站方页面：
  // 同源后注入的 CSS 才能生效（藏掉推荐区），且能带上库中保存的登录态。
  const embedSrc =
    platform === 'bilibili' && bvid
      ? `/api/platforms/bilibili/embed?bvid=${encodeURIComponent(bvid)}`
      : ''
  // 代理不可用时的降级：官方 embed 播放器（无推荐侧栏，但为游客态）
  const fallbackSrc = bvid
    ? `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&high_quality=1&autoplay=0&danmaku=0&as_wide=1`
    : ''

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const res = await api.fetchDetail(platform, uid)
        if (!cancelled) setDetail(res.item)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '详情加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [platform, uid])

  // ESC 关闭 + 打开时锁定背景滚动
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prev
    }
  }, [handleKey])

  // 读取 iframe 内部清扫脚本上报的隐藏数量，用于确认净化是否真的生效
  useEffect(() => {
    if (viewMode !== 'embed' || !embedSrc) return
    const timer = window.setInterval(() => {
      const win = iframeRef.current?.contentWindow as
        | (Window & { __lingoseekStats?: { hidden: number } })
        | undefined
      if (win?.__lingoseekStats) setHiddenCount(win.__lingoseekStats.hidden)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [viewMode, embedSrc])

  const escalateFilter = () => {
    const win = iframeRef.current?.contentWindow as
      | (Window & { __lingoseekEscalate?: () => number })
      | undefined
    if (win && typeof win.__lingoseekEscalate === 'function') {
      setFilterLevel(win.__lingoseekEscalate())
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="animate-pop-in h-screen w-screen max-w-none overflow-y-auto bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- 头部（精简高度） ---- */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-ink-100 bg-white/95 px-4 py-1.5 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="rounded px-2 py-0.5 text-[11px] font-semibold text-white"
              style={{ backgroundColor: accentColor }}
            >
              {platform === 'bilibili' ? '哔哩哔哩' : platform}
            </span>
            <span className="truncate text-xs text-ink-500">
              {isVideo ? '视频详情' : '图文详情'}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* 站方页自带评论区，与自绘内容重复，故提供两种视图供选择 */}
            {isVideo && embedSrc ? (
              <div className="flex rounded-lg bg-slate-100 p-0.5">
                {(
                  [
                    { key: 'embed', label: '站内页' },
                    { key: 'clean', label: '纯净版' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setViewMode(opt.key)}
                    className={`rounded-[7px] px-2.5 py-0.5 text-[11px] font-medium transition-all ${
                      viewMode === opt.key
                        ? 'bg-white text-ink-900 shadow-sm'
                        : 'text-ink-500 hover:text-ink-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : null}

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-300 transition-colors hover:bg-slate-100 hover:text-ink-700"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </div>

        {error ? (
          <div className="px-6 py-12 text-center">
            <div className="mb-3 text-4xl opacity-40">📭</div>
            <p className="text-sm font-medium text-ink-900">详情加载失败</p>
            <p className="mt-1.5 text-xs text-ink-500">{error}</p>
            {detail?.page_url ? (
              <a
                href={detail.page_url}
                target="_blank"
                rel="noreferrer noopener"
                className="btn-ghost mt-4 !text-xs"
              >
                前往原页面查看
              </a>
            ) : null}
          </div>
        ) : (
          <>
            {/* ---- 播放器（仅视频）---- */}
            {/* ---- 视图片：站内页（代理后同源，已隐藏推荐与头部）---- */}
            {isVideo ? (
              viewMode === 'embed' && embedSrc ? (
                <>
                  {/* 播放器铺满视口剩余空间：减去顶部 header 与底部状态栏 */}
                  <div className="h-[calc(100vh-76px)] min-h-[360px] w-full bg-black">
                    <iframe
                      ref={iframeRef}
                      src={embedSrc}
                      title={detail?.title || '视频页面'}
                      className="h-full w-full"
                      frameBorder="0"
                      allowFullScreen
                      referrerPolicy="no-referrer"
                      // 不含 allow-top-navigation：阻止站方脚本破框跳转
                      sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-1.5">
                    <p className="truncate text-[11px] leading-relaxed text-ink-500">
                      已隐藏站方推荐与头部，以你的登录态加载。
                      <span
                        className={`ml-1.5 rounded px-1.5 py-0.5 font-semibold tabular-nums ${
                          hiddenCount > 0
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-amber-50 text-amber-600'
                        }`}
                      >
                        {hiddenCount > 0 ? `已清理 ${hiddenCount} 个元素` : '清理脚本运行中…'}
                      </span>
                      {filterLevel > 0 ? `（过滤强度 ${filterLevel}）` : ''}
                    </p>
                    {/* 站方推荐容器的类名由客户端 JS 生成、服务端无从得知，
                        故提供逐级加强的按钮，按实际效果推进 */}
                    <button
                      type="button"
                      onClick={escalateFilter}
                      className="shrink-0 rounded-lg border border-ink-100 bg-white px-2 py-0.5
                                 text-[11px] text-ink-700 transition-colors hover:border-ink-300"
                    >
                      推荐还在？加强过滤
                    </button>
                  </div>
                </>
              ) : (
                fallbackSrc ? (
                  <>
                    <div className="aspect-video w-full bg-black">
                      <iframe
                        src={fallbackSrc}
                        title={detail?.title || '视频播放'}
                        className="h-full w-full"
                        frameBorder="0"
                        scrolling="no"
                        allowFullScreen
                        referrerPolicy="no-referrer"
                      />
                    </div>
                    <p className="bg-amber-50 px-4 py-2 text-[11px] leading-relaxed text-amber-700">
                      ⚠ 官方嵌入播放器为游客态：跨域 iframe 无法继承登录态，更高清晰度请在哔哩哔哩打开。
                    </p>
                  </>
                ) : null
              )
            ) : null}

            {/* ---- 详情区：纯净视图（或图文）才渲染，避免与站内页重复 ---- */}
            <div className={isVideo && viewMode === 'embed' && embedSrc ? 'hidden' : 'p-5'}>
              {loading && !detail ? (
                <div className="space-y-3">
                  <div className="h-5 w-3/4 animate-pulse rounded bg-slate-100" />
                  <div className="h-4 w-1/3 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
                </div>
              ) : detail ? (
                <>
                  <h2 className="text-base font-bold leading-snug text-ink-900">{detail.title}</h2>

                  {/* UP 主 */}
                  <div className="mt-3 flex items-center gap-2.5">
                    {detail.author.avatar_url ? (
                      <img
                        src={detail.author.avatar_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-9 w-9 rounded-full object-cover ring-1 ring-ink-100"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.visibility = 'hidden'
                        }}
                      />
                    ) : (
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm">
                        👤
                      </div>
                    )}
                    <div className="min-w-0">
                      <a
                        href={detail.author.homepage || '#'}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="block truncate text-sm font-medium text-ink-900 hover:text-bilibili"
                      >
                        {detail.author.name || '匿名'}
                      </a>
                      <span className="text-[11px] text-ink-300">
                        {formatRelativeTime(detail.published_at)}
                        {isVideo && detail.duration
                          ? ` · 时长 ${formatDuration(detail.duration)}`
                          : ''}
                      </span>
                    </div>
                  </div>

                  {/* 数据指标 */}
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 rounded-xl bg-slate-50 px-4 py-3">
                    <Metric label="播放" value={formatCount(detail.view_count)} />
                    {isVideo ? <Metric label="弹幕" value={formatCount(detail.danmaku_count)} /> : null}
                    <Metric label="点赞" value={formatCount(detail.like_count)} />
                    <Metric label="投币" value={formatCount(detail.coin_count)} />
                    <Metric label="收藏" value={formatCount(detail.favorite_count)} />
                    <Metric label="评论" value={formatCount(detail.comment_count)} />
                  </div>

                  {/* 简介 */}
                  {detail.summary ? (
                    <div className="mt-4">
                      <h3 className="mb-1.5 text-xs font-semibold text-ink-700">简介</h3>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-500">
                        {detail.summary}
                      </p>
                    </div>
                  ) : null}

                  {/* 标签 */}
                  {detail.tags.length > 0 ? (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {detail.tags.map((tag) => (
                        <span key={tag} className="chip bg-slate-100 text-ink-500">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {/* 原文链接：这是获得完整登录体验的唯一出口，故用主按钮样式 */}
                  {detail.page_url ? (
                    <a
                      href={detail.page_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="btn-primary mt-5 w-full !text-xs"
                      style={{ backgroundColor: accentColor }}
                    >
                      在{platform === 'bilibili' ? '哔哩哔哩' : '平台'}打开（含登录态）↗
                    </a>
                  ) : null}

                  {/* 评论区：同样取结构化数据自绘，不夹带平台推荐 */}
                  <CommentSection platform={platform} uid={uid} />
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-sm font-semibold tabular-nums text-ink-900">{value}</span>
      <span className="text-[11px] text-ink-300">{label}</span>
    </div>
  )
}
