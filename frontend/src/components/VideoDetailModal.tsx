import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  formatCount,
  formatDuration,
  formatRelativeTime,
  type ContentCard,
  type PlayurlInfo,
  type YoutubeStreamsInfo,
} from '../api/client'
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
  // 小红书：图片列表（图文笔记）与视频源（视频笔记），均由后端 fetch_detail 返回
  const xhsImages = (detail?.extra?.images as string[] | undefined) ?? []
  const xhsVideo = (detail?.extra?.video as string | undefined) ?? ''
  const isXhs = platform === 'xiaohongshu'
  const isBili = platform === 'bilibili'
  const isYoutube = platform === 'youtube'
  // YouTube 视频 ID：详情到位后用详情的 uid，否则退回列表传入的 uid
  const ytId = isYoutube ? detail?.uid || uid : ''
  // YouTube 官方 embed（隐私增强域名）。
  // 注意：这是唯一一处由浏览器直连站方的播放器 —— 服务端能访问 YouTube 不代表
  // 浏览器也能，浏览器不可达时会是空白框，故下面同时给出「在 YouTube 打开」入口。
  const ytEmbedSrc = ytId ? `https://www.youtube-nocookie.com/embed/${ytId}` : ''

  // 下载弹窗状态
  const [showDownload, setShowDownload] = useState(false)
  const [playurlInfo, setPlayurlInfo] = useState<PlayurlInfo | null>(null)
  const [ytStreams, setYtStreams] = useState<YoutubeStreamsInfo | null>(null)
  const [ytFormatId, setYtFormatId] = useState('merge')
  const [downloadLoading, setDownloadLoading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [downloadCid, setDownloadCid] = useState<number | undefined>(undefined)

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
        // 小红书详情需要 xsec_token（搜索结果里携带），附加到 uid 传给后端
        const xsecToken = (fallback?.extra?.xsec_token as string | undefined) ?? ''
        const detailUid = platform === 'xiaohongshu' && xsecToken ? `${uid}|${xsecToken}` : uid
        const res = await api.fetchDetail(platform, detailUid)
        if (!cancelled) {
          const fetched = res.item
          // 详情数据与搜索结果 fallback 合并：详情页偶发拿不全（风控/加载慢），
          // 缺失字段回退 fallback，避免「有数据但标题/图片空白」的倒退体验
          const merged: ContentCard = {
            ...fetched,
            title: fetched.title || fallback?.title || '',
            summary: fetched.summary || fallback?.summary || '',
            cover_url: fetched.cover_url || fallback?.cover_url || '',
            like_count: fetched.like_count || fallback?.like_count || 0,
            comment_count: fetched.comment_count || fallback?.comment_count || 0,
            favorite_count: fetched.favorite_count || fallback?.favorite_count || 0,
            share_count: fetched.share_count || fallback?.share_count || 0,
            published_at: fetched.published_at ?? fallback?.published_at ?? null,
            author: fetched.author?.name ? fetched.author : (fallback?.author ?? fetched.author),
            extra: { ...(fallback?.extra ?? {}), ...(fetched.extra ?? {}) },
          }
          setDetail(merged)
        }
      } catch (err) {
        // 小红书 / 抖音：详情接口可能被风控（小红书需 xsec、抖音详情未实现），
        // 失败时静默降级，用 fallback 数据展示，避免弹错误遮住本来可看的内容。
        if ((platform === 'xiaohongshu' || platform === 'douyin') && fallback) {
          if (!cancelled) {
            setDetail(fallback)
            setError('')
          }
        } else {
          if (!cancelled) setError(err instanceof Error ? err.message : '详情加载失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 打开下载弹窗：B 站拉播放直链（分 P + 清晰度），YouTube 拉可下载流列表
  const openDownload = async () => {
    if (isYoutube) {
      if (!ytId) return
      setShowDownload(true)
      setDownloadLoading(true)
      setDownloadError('')
      setYtStreams(null)
      try {
        const info = await api.fetchYoutubeStreams(ytId)
        setYtStreams(info)
        // 默认选「音视频合并」；后端没有 ffmpeg 时退到最高清的纯视频流
        setYtFormatId(info.ffmpeg_available ? 'merge' : (info.streams[0]?.format_id ?? ''))
      } catch (err) {
        setDownloadError(err instanceof Error ? err.message : '获取下载信息失败')
      } finally {
        setDownloadLoading(false)
      }
      return
    }

    if (!bvid) return
    setShowDownload(true)
    setDownloadLoading(true)
    setDownloadError('')
    setPlayurlInfo(null)
    try {
      const info = await api.fetchPlayurl(bvid)
      setPlayurlInfo(info)
      setDownloadCid(info.current_cid)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : '获取下载信息失败')
    } finally {
      setDownloadLoading(false)
    }
  }

  // 切换分 P：重新拉取该 cid 的播放地址
  const switchCid = async (cid: number) => {
    if (!bvid) return
    setDownloadCid(cid)
    setDownloadLoading(true)
    setDownloadError('')
    try {
      const info = await api.fetchPlayurl(bvid, cid)
      setPlayurlInfo(info)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : '获取下载信息失败')
    } finally {
      setDownloadLoading(false)
    }
  }

  // 触发下载：走后端代理（B 站直链有防盗链，YouTube 直链绑定 IP 且浏览器常不可达）
  const doDownload = () => {
    if (isYoutube) {
      if (!ytId || !ytFormatId) return
      window.location.href = api.youtubeDownloadUrl(ytId, ytFormatId)
      return
    }
    if (!bvid) return
    const url = `/api/platforms/bilibili/download?bvid=${encodeURIComponent(bvid)}` +
      (downloadCid ? `&cid=${downloadCid}` : '')
    window.location.href = url
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
            {/* 视频下载入口（B 站走播放直链，YouTube 走 yt-dlp 取流） */}
            {(isBili && isVideo && bvid) || (isYoutube && ytId) ? (
              <button
                type="button"
                onClick={openDownload}
                className="shrink-0 rounded-lg border border-ink-100 bg-white px-2.5 py-0.5
                           text-[11px] font-medium text-ink-700 transition-colors hover:border-bilibili hover:text-bilibili"
              >
                ⬇ 下载
              </button>
            ) : null}

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
            {/* ---- YouTube：官方 embed 播放器 ---- */}
            {/* 这是浏览器直连站方的一次尝试：播放能不能成取决于浏览器自身的网络。
                服务端能访问 YouTube 不代表浏览器也能，所以下面还要保留
                「在 YouTube 打开」入口作为兜底。 */}
            {isYoutube && ytEmbedSrc ? (
              <div className="aspect-video w-full bg-black">
                <iframe
                  src={ytEmbedSrc}
                  title={detail?.title || 'YouTube 视频'}
                  className="h-full w-full"
                  frameBorder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  referrerPolicy="no-referrer"
                />
              </div>
            ) : null}
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
                  <h2 className="text-base font-bold leading-snug text-ink-900">
                    {detail.title || (platform === 'douyin' ? '抖音视频' : '')}
                  </h2>

                  {/* ---- 抖音：详情接口未实现，展示封面 + 站内打开引导 ---- */}
                  {platform === 'douyin' && detail.cover_url ? (
                    <div className="mt-4">
                      <img
                        src={detail.cover_url}
                        alt={detail.title || '抖音视频封面'}
                        referrerPolicy="no-referrer"
                        className="w-full max-w-md rounded-xl object-contain"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                        ⚠ 抖音详情接口受 a_bogus 签名保护，暂无法在站内直接播放。
                        点击右上角「在抖音打开（含登录态）」可跳转原页面观看完整视频。
                      </p>
                    </div>
                  ) : null}

                  {/* ---- 小红书：图文笔记的图片列表 / 视频笔记的播放器 ---- */}
                  {isXhs && !isVideo && xhsImages.length > 0 ? (
                    <div className="mt-4 grid grid-cols-1 gap-3">
                      {xhsImages.map((src, i) => (
                        <img
                          key={i}
                          src={src}
                          alt={`${detail.title} 图${i + 1}`}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="w-full rounded-xl object-contain"
                          onError={(e) => {
                            ;(e.target as HTMLImageElement).style.display = 'none'
                          }}
                        />
                      ))}
                    </div>
                  ) : null}

                  {isXhs && isVideo && xhsVideo ? (
                    <div className="mt-4 overflow-hidden rounded-xl bg-black">
                      <video
                        src={xhsVideo}
                        controls
                        playsInline
                        preload="metadata"
                        className="aspect-video w-full"
                      />
                    </div>
                  ) : null}

                  {isXhs && isVideo && !xhsVideo && detail.cover_url ? (
                    <div className="mt-4">
                      <img
                        src={detail.cover_url}
                        alt={detail.title}
                        referrerPolicy="no-referrer"
                        className="w-full max-w-md rounded-xl object-contain"
                      />
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                        ⚠ 该视频笔记的播放源被小红书风控拦截（详情页需通过官方验证码校验），
                        无法在站内直接播放。点开正文可看简介与互动数据，观看请前往原页面。
                      </p>
                    </div>
                  ) : null}

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
                    {isXhs ? (
                      <>
                        <Metric label="点赞" value={formatCount(detail.like_count)} />
                        <Metric label="收藏" value={formatCount(detail.favorite_count)} />
                        <Metric label="评论" value={formatCount(detail.comment_count)} />
                        <Metric label="分享" value={formatCount(detail.share_count)} />
                      </>
                    ) : platform === 'douyin' ? (
                      <>
                        <Metric label="点赞" value={formatCount(detail.like_count)} />
                        <Metric label="评论" value={formatCount(detail.comment_count)} />
                        <Metric label="收藏" value={formatCount(detail.favorite_count)} />
                        <Metric label="分享" value={formatCount(detail.share_count)} />
                      </>
                    ) : isYoutube ? (
                      // YouTube 只拿得到播放量：点赞数不在详情页的 playerResponse 里，
                      // 与其显示一个假的 0，不如不显示。
                      <>
                        <Metric label="播放" value={formatCount(detail.view_count)} />
                        <Metric
                          label="时长"
                          value={detail.duration ? formatDuration(detail.duration) : '—'}
                        />
                      </>
                    ) : (
                      <>
                        <Metric label="播放" value={formatCount(detail.view_count)} />
                        {isVideo ? <Metric label="弹幕" value={formatCount(detail.danmaku_count)} /> : null}
                        <Metric label="点赞" value={formatCount(detail.like_count)} />
                        <Metric label="投币" value={formatCount(detail.coin_count)} />
                        <Metric label="收藏" value={formatCount(detail.favorite_count)} />
                        <Metric label="评论" value={formatCount(detail.comment_count)} />
                      </>
                    )}
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
                      在{platform === 'bilibili' ? '哔哩哔哩' : platform === 'douyin' ? '抖音' : platform === 'youtube' ? 'YouTube' : '平台'}打开（含登录态）↗
                    </a>
                  ) : null}

                  {/* 评论区：同样取结构化数据自绘，不夹带平台推荐。小红书/抖音评论尚未接入，先禁用 */}
                  <CommentSection platform={platform} uid={uid} enabled={!isXhs && platform !== 'douyin' && !isYoutube} />
                </>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* ---- 下载弹窗 ---- */}
      {showDownload ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={() => setShowDownload(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-900">下载视频</h3>
              <button
                type="button"
                onClick={() => setShowDownload(false)}
                className="rounded-lg p-1 text-ink-300 hover:bg-slate-100 hover:text-ink-700"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>

            {downloadLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-ink-500">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-ink-700" />
                正在获取播放地址…
              </div>
            ) : downloadError ? (
              <div className="py-4 text-center">
                <p className="text-xs leading-relaxed text-amber-700">{downloadError}</p>
              </div>
            ) : playurlInfo ? (
              <div className="space-y-4">
                {/* 分 P 选择（多 P 视频才显示） */}
                {playurlInfo.pages.length > 1 ? (
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium text-ink-500">选择分 P</p>
                    <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                      {playurlInfo.pages.map((p) => (
                        <button
                          key={p.cid}
                          type="button"
                          onClick={() => void switchCid(p.cid)}
                          className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                            downloadCid === p.cid
                              ? 'bg-bilibili text-white'
                              : 'bg-slate-100 text-ink-600 hover:bg-slate-200'
                          }`}
                        >
                          {p.part || `P${p.page}`}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* 清晰度信息 */}
                <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-[11px] leading-relaxed text-ink-600">
                  <p>
                    当前可下载清晰度：
                    <span className="font-semibold text-ink-900">
                      {playurlInfo.quality_desc || `${playurlInfo.quality}P`}
                    </span>
                  </p>
                  <p className="mt-1 text-ink-400">
                    {playurlInfo.formats.length > 0
                      ? `支持：${playurlInfo.formats.map((f) => f.desc).join(' / ')}`
                      : ''}
                  </p>
                  <p className="mt-1 text-amber-600">
                    ⚠ 清晰度上限取决于登录态（游客 480P，登录 1080P，大会员更高）。
                  </p>
                </div>

                <button
                  type="button"
                  onClick={doDownload}
                  className="btn-primary w-full !text-xs"
                  style={{ backgroundColor: accentColor }}
                >
                  开始下载（{playurlInfo.title || bvid}）
                </button>
              </div>
            ) : ytStreams ? (
              <div className="space-y-4">
                <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-[11px] leading-relaxed text-ink-600">
                  <p className="font-semibold text-ink-900">{ytStreams.title}</p>
                  {ytStreams.ffmpeg_available ? (
                    <p className="mt-1">✅ 已检测到 ffmpeg，可下载带声音的完整视频。</p>
                  ) : (
                    <p className="mt-1 text-amber-600">
                      ⚠ 未检测到 ffmpeg。YouTube 只提供音视频分离的流，
                      不装 ffmpeg 就只能下载纯视频（无声音）或纯音频。
                    </p>
                  )}
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-medium text-ink-500">选择格式</p>
                  <div className="flex max-h-52 flex-col gap-1.5 overflow-y-auto">
                    {ytStreams.ffmpeg_available ? (
                      <button
                        type="button"
                        onClick={() => setYtFormatId('merge')}
                        className={`rounded-lg px-3 py-1.5 text-left text-[11px] transition-colors ${
                          ytFormatId === 'merge'
                            ? 'bg-bilibili text-white'
                            : 'bg-slate-100 text-ink-600 hover:bg-slate-200'
                        }`}
                      >
                        🎬 音视频合并（最佳画质，需 ffmpeg 合成，耗时较长）
                      </button>
                    ) : null}
                    {ytStreams.streams
                      .filter((s) => s.has_video)
                      .slice(0, 12)
                      .map((s) => (
                        <button
                          key={s.format_id}
                          type="button"
                          onClick={() => setYtFormatId(s.format_id)}
                          className={`rounded-lg px-3 py-1.5 text-left text-[11px] transition-colors ${
                            ytFormatId === s.format_id
                              ? 'bg-bilibili text-white'
                              : 'bg-slate-100 text-ink-600 hover:bg-slate-200'
                          }`}
                        >
                          {s.resolution || s.note} · {s.ext}
                          <span className="opacity-70">
                            {' '}
                            （纯视频，无声音{formatSize(s.filesize)}）
                          </span>
                        </button>
                      ))}
                    {(() => {
                      const bestAudio = ytStreams.streams
                        .filter((s) => !s.has_video && s.has_audio)
                        .sort((a, b) => b.abr - a.abr)[0]
                      if (!bestAudio) return null
                      return (
                        <button
                          type="button"
                          onClick={() => setYtFormatId(bestAudio.format_id)}
                          className={`rounded-lg px-3 py-1.5 text-left text-[11px] transition-colors ${
                            ytFormatId === bestAudio.format_id
                              ? 'bg-bilibili text-white'
                              : 'bg-slate-100 text-ink-600 hover:bg-slate-200'
                          }`}
                        >
                          🎵 仅音频（{Math.round(bestAudio.abr)}kbps
                          {formatSize(bestAudio.filesize)}）
                        </button>
                      )
                    })()}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={doDownload}
                  className="btn-primary w-full !text-xs"
                  style={{ backgroundColor: accentColor }}
                >
                  {ytFormatId === 'merge' ? '开始下载（需服务端合并，请稍候）' : '开始下载（需服务端拉取，请稍候）'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? ` · ${(mb / 1024).toFixed(1)}GB` : ` · ${Math.round(mb)}MB`
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-sm font-semibold tabular-nums text-ink-900">{value}</span>
      <span className="text-[11px] text-ink-300">{label}</span>
    </div>
  )
}
