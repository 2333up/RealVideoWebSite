import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type AccountBrief,
  type ContentCard,
  type ContentKind,
  type PlatformMeta,
  type SearchOrder,
  type SearchResponse,
} from './api/client'
import ResultCard from './components/ResultCard'
import LoginModal from './components/LoginModal'
import AccountPanel from './components/AccountPanel'
import VideoDetailModal from './components/VideoDetailModal'
import XhsEmbedResult from './components/XhsEmbedResult'
import DouyinEmbedResult from './components/DouyinEmbedResult'
// 大模型设置与大模型密钥是**两个产品共用**的一份配置（存在 video-mind/backend/.env）。
// 因此灵搜直接复用 video-mind 的 SettingsPanel 并只取其中的「大模型」区块，
// 而不是另写一套：两套 UI 各自演进，迟早会出现「这边改了 key 那边看不到」。
import SettingsPanel from './videomind/components/SettingsPanel'

const ORDER_OPTIONS: { key: SearchOrder; label: string; hint: string }[] = [
  { key: 'relevance', label: '综合排序', hint: '沿用平台的原生综合相关度' },
  { key: 'hot', label: '最多播放', hint: '按平台播放量排序' },
  { key: 'new', label: '最新发布', hint: '按发布时间排序' },
]

// 标签刻意做短，以便做成按钮组横向排布（原生下拉框与整体风格割裂）
const DURATION_OPTIONS: { label: string; min: number | null; max: number | null }[] = [
  { label: '不限', min: null, max: null },
  { label: '≤10分', min: null, max: 600 },
  { label: '10-30分', min: 600, max: 1800 },
  { label: '30-60分', min: 1800, max: 3600 },
  { label: '>60分', min: 3600, max: null },
]

const KIND_OPTIONS: { key: ContentKind; label: string }[] = [
  { key: 'video', label: '视频' },
  { key: 'article', label: '图文' },
]

// 播放量 / 粉丝量门槛。数值取整档，避免让用户自己填数字。
// 注意这两个条件只在 supports_thresholds 的平台（目前是 B 站）显示 ——
// 拿不到数据的平台会忽略条件，显示出来等于给了个假开关。
const VIEW_OPTIONS: { label: string; value: number | null }[] = [
  { label: '不限', value: null },
  { label: '≥1万', value: 10_000 },
  { label: '≥10万', value: 100_000 },
  { label: '≥50万', value: 500_000 },
  { label: '≥100万', value: 1_000_000 },
]

const FOLLOWER_OPTIONS: { label: string; value: number | null }[] = [
  { label: '不限', value: null },
  { label: '≥1万粉', value: 10_000 },
  { label: '≥10万粉', value: 100_000 },
  { label: '≥50万粉', value: 500_000 },
  { label: '≥100万粉', value: 1_000_000 },
]

// video-mind 入口。融合为单一应用后它就是本工程的一条前端路由
// （见 src/App.tsx），同源同端口，直接客户端跳转即可 —— 不再需要
// 新开标签页，也不需要探测它是否启动（同一个 dev server，起没起一目了然）。
const VIDEOMIND_URL = '/videomind/'

/** 卡片固定 250×210，由 auto-fill 决定每行列数，随浏览器宽度自适应 */
const CARD_W = 250
const GRID_GAP = 16
const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, ${CARD_W}px)`,
  gap: `${GRID_GAP}px`,
  justifyContent: 'center',
}

export default function App() {
  const [platforms, setPlatforms] = useState<PlatformMeta[]>([])
  const [accounts, setAccounts] = useState<AccountBrief[]>([])
  const [selectedPlatform, setSelectedPlatform] = useState<string>('bilibili')

  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)

  const [order, setOrder] = useState<SearchOrder>('relevance')
  const [kinds, setKinds] = useState<ContentKind[]>(['video', 'article'])
  const [durationIdx, setDurationIdx] = useState(0)
  // 播放量 / 粉丝量门槛（null = 不限）。仅在平台声明 supports_thresholds 时可用。
  const [minViews, setMinViews] = useState<number | null>(null)
  const [minFollowers, setMinFollowers] = useState<number | null>(null)

  const [loginOpen, setLoginOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [loginPlatform, setLoginPlatform] = useState<PlatformMeta | null>(null)
  // 大模型 API 设置浮层（复用 video-mind 的 SettingsPanel，只显示大模型区块）
  const [settingsOpen, setSettingsOpen] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  // 底部哨兵：滚动到其附近时自动加载下一批
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 详情浮层目标：点击结果卡片时填入，关闭时清空
  const [detailTarget, setDetailTarget] = useState<{
    platform: string
    uid: string
    fallback: ContentCard
  } | null>(null)

  // 首屏加载平台元信息与账号清单
  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [platformRes, accountRes] = await Promise.all([api.platforms(), api.listAccounts()])
        setPlatforms(platformRes.platforms)
        setAccounts(accountRes.accounts)
        if (platformRes.platforms.length > 0) {
          setSelectedPlatform(platformRes.platforms[0].key)
        }
      } catch {
        // 后端未就绪时不阻塞界面，用户搜索时会看到明确提示
      }
    }
    void bootstrap()
  }, [])

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await api.listAccounts()
      setAccounts(res.accounts)
    } catch {
      /* 静默失败，面板会保留上一次数据 */
    }
  }, [])

  // 每次向平台抓取的页数，用于「加载更多」时向后翻
  const [nextPage, setNextPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const PAGE_BATCH = 4
  const RESULT_BATCH_SIZE = 60

  const runSearch = useCallback(
    async (targetKeyword: string, append = false) => {
      const term = targetKeyword.trim()
      if (!term) {
        inputRef.current?.focus()
        return
      }

      const page = append ? nextPage : 1
      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
        setError('')
        setResult(null)
        setSubmitted(term)
        setHasSearched(true)
        setNextPage(1 + PAGE_BATCH)
        setHasMore(false)
      }

      // 小红书 / 抖音走「整页嵌入」方案：不发结构化搜索请求，直接把官方搜索页
      // 通过服务端代理嵌进 iframe。这样点击内容由平台自己渲染详情，
      // 绕开「自建详情被风控」的问题。
      if (selectedPlatform === 'xiaohongshu' || selectedPlatform === 'douyin') {
        setLoading(false)
        setLoadingMore(false)
        return
      }

      const duration = DURATION_OPTIONS[durationIdx]
      try {
        const data = await api.search({
          keyword: term,
          platforms: [selectedPlatform],
          page,
          pages: PAGE_BATCH,
          page_size: RESULT_BATCH_SIZE,
          kinds: kinds.length > 0 ? kinds : ['video'],
          order,
          duration_min: duration.min,
          duration_max: duration.max,
          min_views: minViews,
          min_followers: minFollowers,
        })

        setResult((prev) => {
          if (!append) return data
          // 跨批次按 unique key 去重，避免同一条最终结果在不同批次重复出现
          const seen = new Set((prev?.items ?? []).map((i) => `${i.platform}-${i.kind}-${i.uid}`))
          const fresh = data.items.filter((i) => !seen.has(`${i.platform}-${i.kind}-${i.uid}`))
          return { ...data, items: [...(prev?.items ?? []), ...fresh] }
        })
        setNextPage(page + PAGE_BATCH)
        // 关键：只有当「本次返回了去重后的新内容」才继续「加载更多」。
        // 抖音等浏览器自动化平台无法真正翻页，加载更多常返回重复内容，
        // 若去重后为空仍置 hasMore=true，会导致无限滚动死循环（一直加载、耗时极长）。
        if (append) {
          const seen = new Set((result?.items ?? []).map((i) => `${i.platform}-${i.kind}-${i.uid}`))
          const hasNew = data.items.some((i) => !seen.has(`${i.platform}-${i.kind}-${i.uid}`))
          setHasMore(hasNew)
        } else {
          setHasMore(data.items.length > 0)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '检索失败，请稍后重试')
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [durationIdx, kinds, minFollowers, minViews, nextPage, order, selectedPlatform],
  )

  // 滚动到底部自动加载下一批。
  // rootMargin 提前 500px 触发，让用户在滚到底之前数据就已就位，观感上「无限滚动」。
  // 三个加载态任一为真时都不注册观察器，避免重复触发。
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasSearched || !hasMore || loading || loadingMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          void runSearch(submitted, true)
        }
      },
      { rootMargin: '500px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearched, hasMore, loading, loadingMore, submitted])

  // 筛选条件变化时自动重新检索（切换平台 / 排序 / 类型 / 时长均会命中）。
  // 依赖用字符串指纹而非数组/对象，避免引用变化导致的误触发；
  // 加 420ms 防抖，防止连续切换条件时连发请求打到平台风控。
  const filterKey = `${selectedPlatform}|${order}|${kinds.join(',')}|${durationIdx}|${minViews}|${minFollowers}`
  useEffect(() => {
    if (!hasSearched || !submitted || loading) return
    const timer = window.setTimeout(() => {
      void runSearch(submitted)
    }, 420)
    return () => window.clearTimeout(timer)
    // 仅在筛选条件指纹变化时触发，runSearch 内部状态变化不应重新触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  // 当前平台元信息：不同平台支持的内容形态不同（如抖音暂无图文检索）
  const platformMeta = useMemo(
    () => platforms.find((p) => p.key === selectedPlatform),
    [platforms, selectedPlatform],
  )
  const platformColor = platformMeta?.accent_color ?? '#FB7299'

  const activeAccount = useMemo(
    () => accounts.find((a) => a.platform === selectedPlatform && a.is_default),
    [accounts, selectedPlatform],
  )

  const toggleKind = (kind: ContentKind) => {
    setKinds((prev) => {
      const next = prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
      // 至少保留一种内容形态，否则无法检索
      return next.length > 0 ? next : prev
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void runSearch(keyword)
  }

  const items = result?.items ?? []

  return (
    <div className="min-h-screen">
      {/* ---------------- 顶栏 ---------------- */}
      <header className="sticky top-0 z-30 border-b border-ink-100/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto max-w-[1400px] px-5 py-2">
          <div className="flex items-center gap-3">
            {/* Logo（精简为单图标，去掉两行文字以降低顶栏高度） */}
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base text-white shadow-sm"
              style={{ backgroundColor: platformColor }}
              title="灵搜 LingoSeek"
            >
              🔍
            </span>

            {/* 搜索框 */}
            <form onSubmit={handleSubmit} className="flex flex-1 items-center gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-300">
                  ⌕
                </span>
                <input
                  ref={inputRef}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="输入关键词，让引擎替你筛选真正值得看的内容…"
                  className="w-full rounded-lg border border-ink-100 bg-slate-50 py-1.5 pl-8 pr-3 text-sm
                             text-ink-900 outline-none transition-all placeholder:text-ink-300
                             focus:border-transparent focus:bg-white focus:ring-2"
                  style={{ ['--tw-ring-color' as string]: `${platformColor}55` }}
                />
              </div>
              <button type="submit" disabled={loading} className="btn-primary shrink-0 !px-5 !py-1.5 !text-sm">
                {loading ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : (
                  '搜索'
                )}
              </button>
            </form>

            {/* 融合后 video-mind 是本应用的一条路由，用 Link 做客户端跳转：
                不刷新页面、不新开标签页，搜索状态（关键词/结果/滚动位置）都留着。
                以前那套 <a target="_blank"> + fetch 探测是跨 dev server 时代的产物。 */}
            <Link
              to={VIDEOMIND_URL}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-100 bg-white py-1 pl-2 pr-2.5
                         text-xs font-medium text-ink-700 transition-colors hover:border-ink-300"
              title="打开 Video-Mind · 本地视频分章节与思维导图"
            >
              <span aria-hidden>🎬</span>
              <span className="hidden md:block">Video-Mind</span>
            </Link>

            {/* 大模型 API 设置：与 video-mind 共用同一份配置，见顶部 import 注释 */}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-ink-100
                         bg-white text-sm text-ink-700 transition-colors hover:border-ink-300"
              title="大模型 API 设置（与 Video-Mind 共用）"
              aria-label="大模型 API 设置"
            >
              <span aria-hidden>⚙</span>
            </button>

            {/* 账号入口（精简高度） */}
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-100 bg-white py-1 pl-1.5 pr-2.5
                         transition-colors hover:border-ink-300"
              title="管理平台账号"
            >
              {activeAccount?.avatar_url ? (
                <img
                  src={activeAccount.avatar_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-5 w-5 rounded-full object-cover ring-1 ring-ink-100"
                />
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-xs">
                  👤
                </span>
              )}
              <span className="hidden max-w-[7rem] truncate text-xs font-medium text-ink-700 md:block">
                {activeAccount?.nickname ?? '未登录'}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* ---------------- 筛选区 ----------------
          改动筛选条件后会自动重新检索（见下方 filterKey 副作用） */}
      <div className="mx-auto max-w-[1400px] px-5 pt-3">
        <div className="surface flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          {/* 平台切换 */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-500">平台</span>
            <div className="flex gap-1.5">
              {platforms.length === 0 ? (
                <span className="chip bg-slate-100 text-ink-300">加载中…</span>
              ) : (
                platforms.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setSelectedPlatform(p.key)}
                    className={`chip transition-all ${
                      selectedPlatform === p.key
                        ? 'text-white shadow-sm ring-2 ring-offset-1'
                        : 'bg-slate-100 text-ink-500 hover:bg-slate-200'
                    }`}
                    style={
                      selectedPlatform === p.key
                        ? { backgroundColor: p.accent_color, ['--tw-ring-color' as string]: `${p.accent_color}66` }
                        : undefined
                    }
                  >
                    {p.display_name}
                  </button>
                ))
              )}
            </div>
          </div>

          <span className="hidden h-5 w-px bg-ink-100 sm:block" />

          {/* 排序 */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-500">排序</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {ORDER_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  title={opt.hint}
                  onClick={() => setOrder(opt.key)}
                  className={`rounded-[7px] px-3 py-1 text-xs font-medium transition-all ${
                    order === opt.key
                      ? 'bg-white text-ink-900 shadow-sm'
                      : 'text-ink-500 hover:text-ink-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <span className="hidden h-5 w-px bg-ink-100 sm:block" />

          {/* 内容形态 */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-500">类型</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {KIND_OPTIONS.map((opt) => {
                const active = kinds.includes(opt.key)
                // 平台不支持的形态置灰，避免发出注定无结果的请求
                const supported = platformMeta?.supported_kinds.includes(opt.key) ?? true
                return (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={!supported}
                    title={supported ? undefined : `${platformMeta?.display_name ?? '该平台'}暂不支持${opt.label}检索`}
                    onClick={() => toggleKind(opt.key)}
                    className={`rounded-[7px] px-3 py-1 text-xs font-medium transition-all ${
                      !supported
                        ? 'cursor-not-allowed text-ink-300 line-through'
                        : active
                          ? 'bg-white text-ink-900 shadow-sm'
                          : 'text-ink-500 hover:text-ink-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <span className="hidden h-5 w-px bg-ink-100 sm:block" />

          {/* 时长（改为按钮组，避免原生下拉与整体风格割裂） */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-500">时长</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {DURATION_OPTIONS.map((opt, idx) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setDurationIdx(idx)}
                  className={`rounded-[7px] px-2.5 py-1 text-xs font-medium transition-all ${
                    durationIdx === idx
                      ? 'bg-white text-ink-900 shadow-sm'
                      : 'text-ink-500 hover:text-ink-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 播放量 / 粉丝量门槛。
              只在平台声明 supports_thresholds 时渲染 —— 拿不到数据的平台
              会忽略这些条件，摆出来就是个骗人的假开关。 */}
          {platformMeta?.supports_thresholds ? (
            <>
              <span className="hidden h-5 w-px bg-ink-100 sm:block" />

              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink-500">播放量</span>
                <select
                  value={minViews ?? ''}
                  onChange={(e) => setMinViews(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-lg border border-ink-100 bg-slate-50 py-1 pl-2.5 pr-7 text-xs
                             font-medium text-ink-700 focus:border-transparent focus:bg-white focus:ring-2
                             focus:ring-ink-900/10"
                >
                  {VIEW_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.value ?? ''}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink-500">UP主粉丝</span>
                <select
                  value={minFollowers ?? ''}
                  onChange={(e) => setMinFollowers(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-lg border border-ink-100 bg-slate-50 py-1 pl-2.5 pr-7 text-xs
                             font-medium text-ink-700 focus:border-transparent focus:bg-white focus:ring-2
                             focus:ring-ink-900/10"
                >
                  {FOLLOWER_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.value ?? ''}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* ---------------- 结果统计条 ---------------- */}
      {result && !loading ? (
        <div className="mx-auto max-w-[1400px] px-5 pt-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
            <span>
              「<strong className="text-ink-900">{submitted}</strong>」检索到
              <strong className="text-ink-900"> {items.length} </strong>条结果
            </span>
            <span className="text-ink-300">|</span>
            <span>多路召回 {result.total_recalled} 条</span>
            {result.deduped > 0 ? <span>· 剿除重复 {result.deduped} 条</span> : null}
            <span className="text-ink-300">|</span>
            <span className="tabular-nums">耗时 {result.elapsed_ms}ms</span>
            <span
              className={`chip ${
                result.credential_used ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-ink-500'
              }`}
            >
              {result.credential_used ? '已登录检索' : '游客检索'}
            </span>
          </div>
          {result.warnings.length > 0 ? (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠ {result.warnings.join('；')}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- 结果区 ---------------- */}
      <main className="mx-auto max-w-[1400px] px-5 pb-6 pt-4">
        {selectedPlatform === 'douyin' && hasSearched ? (
          <DouyinEmbedResult
            keyword={submitted}
            onOpenVideo={(awemeId, cover) => {
              // 构造最小 fallback（抖音详情接口未实现，浮层展示封面 + 站内打开原页）
              const fallback: ContentCard = {
                platform: 'douyin',
                kind: 'video',
                uid: awemeId,
                title: '',
                summary: '',
                cover_url: cover,
                page_url: `https://www.douyin.com/video/${awemeId}`,
                author: { uid: '', name: '', avatar_url: '', homepage: '' },
                published_at: null,
                duration: null,
                view_count: 0,
                like_count: 0,
                comment_count: 0,
                favorite_count: 0,
                coin_count: 0,
                share_count: 0,
                danmaku_count: 0,
                tags: [],
                score: 0,
                score_detail: {},
                extra: { aweme_id: awemeId },
              }
              setDetailTarget({ platform: 'douyin', uid: awemeId, fallback })
            }}
          />
        ) : selectedPlatform === 'xiaohongshu' && hasSearched ? (
          <XhsEmbedResult
            keyword={submitted}
            onOpenNote={(noteId, cover) => {
              // 构造最小 fallback（详情浮层在 fetch_detail 到达前先顶上空位）
              const fallback: ContentCard = {
                platform: 'xiaohongshu',
                kind: 'article',
                uid: noteId,
                title: '',
                summary: '',
                cover_url: cover,
                page_url: `https://www.xiaohongshu.com/explore/${noteId}`,
                author: { uid: '', name: '', avatar_url: '', homepage: '' },
                published_at: null,
                duration: null,
                view_count: 0,
                like_count: 0,
                comment_count: 0,
                favorite_count: 0,
                coin_count: 0,
                share_count: 0,
                danmaku_count: 0,
                tags: [],
                score: 0,
                score_detail: {},
                extra: { note_id: noteId },
              }
              setDetailTarget({ platform: 'xiaohongshu', uid: noteId, fallback })
            }}
          />
        ) : error ? (
          <div className="surface mx-auto max-w-md p-8 text-center">
            <div className="mb-3 text-4xl">🌐</div>
            <p className="text-sm font-medium text-ink-900">检索未能完成</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{error}</p>
            <button type="button" onClick={() => void runSearch(submitted || keyword)} className="btn-primary mt-4">
              重试
            </button>
          </div>
        ) : loading ? (
          <div style={gridStyle}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-[210px] w-[250px] animate-pulse rounded-xl border border-ink-100/80 bg-white">
                <div className="h-[136px] w-full rounded-t-xl bg-slate-100" />
                <div className="flex flex-col gap-1.5 px-2.5 py-1.5">
                  <div className="h-3 rounded bg-slate-100" />
                  <div className="h-3 w-4/5 rounded bg-slate-100" />
                  <div className="mt-auto h-2.5 w-1/2 rounded bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length > 0 ? (
          <>
            <div style={gridStyle}>
              {items.map((item, idx) => (
                <ResultCard
                  key={`${item.platform}-${item.kind}-${item.uid}`}
                  item={item}
                  index={idx % RESULT_BATCH_SIZE}
                  accentColor={platformColor}
                  onOpen={(it) =>
                    setDetailTarget({ platform: it.platform, uid: it.uid, fallback: it })
                  }
                />
              ))}
            </div>

            {/* 底部哨兵：滚动到此处自动加载下一批；按钮作为观察器失效时的兜底 */}
            <div ref={sentinelRef} className="mt-7 flex flex-col items-center gap-2 py-3">
              {loadingMore ? (
                <div className="flex items-center gap-2 text-sm text-ink-500">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-ink-700" />
                  正在获取更多…
                </div>
              ) : hasMore ? (
                <button
                  type="button"
                  onClick={() => void runSearch(submitted, true)}
                  className="btn-ghost !px-8"
                >
                  加载更多（已获取 {items.length} 条）
                </button>
              ) : (
                <p className="text-xs text-ink-300">已到结果底部，共 {items.length} 条</p>
              )}
            </div>
          </>
        ) : hasSearched ? (
          <div className="surface mx-auto max-w-md p-10 text-center">
            <div className="mb-3 text-5xl opacity-40">🫧</div>
            <p className="text-sm font-medium text-ink-900">没有找到合适的内容</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
              换个关键词试试，或者放宽筛选条件
            </p>
          </div>
        ) : (
          /* 首屏引导 */
          <div className="py-10 text-center">
            <h2 className="text-2xl font-bold text-ink-900">
              一次搜索，
              <span style={{ color: platformColor }}>看遍</span>视频与图文
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink-500">
              输入关键词后，引擎会从视频与图文两条通道并行下探、自动翻页取满结果，
              剔除搬运与重复内容，按平台原生排序列出全部收获。
            </p>

            <div className="mx-auto mt-8 grid max-w-3xl gap-3 sm:grid-cols-3">
              {[
                { icon: '🔀', title: '双路召回', desc: '视频与图文同时下探，不放过任何形态的相关内容' },
                { icon: '📄', title: '自动翻页', desc: '突破单页 20 条限制，一次给足两路结果' },
                { icon: '✂️', title: '剿除重复', desc: '精确去重与作者配额，同系列剧集不再互相顶掉' },
              ].map((card) => (
                <div key={card.title} className="surface p-4 text-left">
                  <div className="mb-2 text-xl">{card.icon}</div>
                  <h3 className="text-sm font-semibold text-ink-900">{card.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">{card.desc}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap justify-center gap-2">
              {['Python教程', '数据结构', 'AI 绘画', '机械键盘', '露营装备'].map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setKeyword(tag)
                    void runSearch(tag)
                  }}
                  className="chip bg-white text-ink-700 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-lifted"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="mx-auto max-w-[1400px] px-5 pb-10 text-center text-[11px] text-ink-300">
        灵搜 LingoSeek v0.1.0 · 数据源 B 站公开接口，内容版权归原作者所有
      </footer>

      {/* ---------------- 浮层 ---------------- */}
      <AccountPanel
        open={panelOpen}
        platforms={platforms}
        accounts={accounts}
        onClose={() => setPanelOpen(false)}
        onRequestLogin={(platform) => {
          setLoginPlatform(platform)
          setPanelOpen(false)
          setLoginOpen(true)
        }}
        onRefresh={refreshAccounts}
      />

      {detailTarget ? (
        <VideoDetailModal
          platform={detailTarget.platform}
          uid={detailTarget.uid}
          accentColor={platformColor}
          fallback={detailTarget.fallback}
          onClose={() => setDetailTarget(null)}
        />
      ) : null}

      {/* 大模型 API 设置：onlyLlm 只渲染大模型区块，
          语音转写与分章节参数是 video-mind 专属，不在此出现 */}
      {settingsOpen ? (
        <SettingsPanel onlyLlm onClose={() => setSettingsOpen(false)} />
      ) : null}

      {loginPlatform ? (
        <LoginModal
          platform={loginPlatform}
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            void refreshAccounts()
            setKeyword('')
          }}
        />
      ) : null}
    </div>
  )
}
