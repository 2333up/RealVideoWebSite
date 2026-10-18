import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type AnimeCandidate,
  type AnimeFollow,
} from '../api/client'

/**
 * 追番页（/anime）。
 *
 * 数据源是 agedm（AGE 动漫）。三个能力：
 *   1. 管理追番列表（搜索添加 / 删除 / 标记已看）
 *   2. 检测更新（有新话的番排前面并标红）
 *   3. 看详情 —— 用后端同源代理的 iframe 嵌入 agedm 详情页
 *
 * ⚠️ 关于「播放」：agedm 全站带 `X-Frame-Options: SAMEORIGIN`，播放器还是
 * **嵌套的第二个 iframe**，同样带 XFO。即使把外层页代理成同源，点集数后
 * 内层播放器仍会被浏览器拒绝（实测是一屏空白）。因此这里只嵌入详情与集数，
 * 并在页面上明确提示「播放请到 AGE 站内」—— 不能假装能播，
 * 否则用户点集数看到空白会以为是我们坏了。
 */

/** 更新状态样式：有更新用 B 站粉强调，避免引入新色板 */
const UPDATE_BADGE = 'bg-bilibili-soft text-bilibili-deep'

export default function AnimeApp() {
  const [follows, setFollows] = useState<AnimeFollow[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')

  // 搜索添加
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [candidates, setCandidates] = useState<AnimeCandidate[] | null>(null)
  const [searchError, setSearchError] = useState('')

  // 当前在右侧查看的作品
  const [viewing, setViewing] = useState<AnimeFollow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setFollows(await api.animeList())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载追番列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 进站自动检测一次更新（任务约定：不轮询）
  const checkedOnce = useRef(false)
  useEffect(() => {
    if (loading || checkedOnce.current || follows.length === 0) return
    checkedOnce.current = true
    void (async () => {
      setChecking(true)
      try {
        await api.animeUpdates()
        setFollows(await api.animeList())
      } catch {
        /* 检测失败不打断浏览，列表仍是本地数据 */
      } finally {
        setChecking(false)
      }
    })()
  }, [loading, follows.length])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    const term = keyword.trim()
    if (!term) return
    setSearching(true)
    setSearchError('')
    setCandidates(null)
    try {
      const res = await api.animeSearch(term)
      setCandidates(res.items)
      if (res.items.length === 0) setSearchError('没有找到相关番剧')
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const handleAdd = async (c: AnimeCandidate) => {
    try {
      await api.animeAdd(c.subject_id)
      setCandidates(null)
      setKeyword('')
      await load()
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : '添加失败')
    }
  }

  const handleRemove = async (f: AnimeFollow) => {
    try {
      await api.animeRemove(f.id)
      if (viewing?.id === f.id) setViewing(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  /** 标记已看：直接拉到最新话，用于消除红点 */
  const handleWatched = async (f: AnimeFollow) => {
    try {
      const updated = await api.animeMarkWatched(f.id, f.latest_eps)
      setFollows((prev) => prev.map((x) => (x.id === f.id ? updated : x)))
      if (viewing?.id === f.id) setViewing(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  const updateCount = follows.filter((f) => f.has_update).length

  const renderFrame = (f: AnimeFollow | null) => {
    if (!f) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
          <div className="mb-3 text-4xl opacity-30">📺</div>
          <p className="text-sm font-medium text-ink-700">选一部番查看详情</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            右侧会嵌入 AGE 动漫的详情页，可以看到简介与集数。
          </p>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-ink-100 px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink-900">{f.title}</div>
            <div className="truncate text-[11px] text-ink-500">
              {f.latest_label || `${f.latest_eps} 话`}
              {f.has_update ? ' · 有新话' : ''}
            </div>
          </div>
          <a
            href={api.animeSiteUrl(f.subject_id)}
            target="_blank"
            rel="noreferrer noopener"
            className="btn-ghost !px-3 !py-1 !text-xs"
            title="播放器无法在应用内嵌入，点击到 AGE 站内观看"
          >
            到站内观看 ↗
          </a>
        </div>
        {/* 代理成同源的 agedm 详情页。播放需点上面那个按钮去站内。 */}
        <iframe
          key={f.subject_id}
          src={api.animeEmbedUrl(f.subject_id)}
          className="w-full flex-1 border-0"
          title={f.title}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      {/* ---------------- 顶栏 ---------------- */}
      <header className="sticky top-0 z-30 border-b border-ink-100/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-5 py-2">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-100 bg-white py-1 pl-2 pr-2.5
                       text-xs font-medium text-ink-700 transition-colors hover:border-ink-300"
            title="返回灵搜"
          >
            <span aria-hidden>←</span>
            <span className="hidden sm:block">灵搜</span>
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium text-ink-900">追番</span>
            {updateCount > 0 ? (
              <span className={`chip ${UPDATE_BADGE}`}>{updateCount} 部有更新</span>
            ) : null}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void load()}
            className="btn-ghost !px-3 !py-1 !text-xs"
            disabled={loading}
          >
            刷新
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 py-4">
        {/* ---------------- 搜索添加 ---------------- */}
        <form onSubmit={handleSearch} className="mb-4 flex items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入番剧名添加追番…"
            className="w-full max-w-sm rounded-lg border border-ink-100 bg-slate-50 px-3 py-1.5 text-sm
                       text-ink-900 outline-none transition-all placeholder:text-ink-300
                       focus:border-transparent focus:bg-white focus:ring-2 focus:ring-bilibili/30"
          />
          <button type="submit" className="btn-primary shrink-0 !px-4 !py-1.5 !text-sm" disabled={searching}>
            {searching ? '搜索中…' : '搜索'}
          </button>
        </form>

        {searchError ? (
          <p className="mb-3 text-xs text-amber-600">{searchError}</p>
        ) : null}

        {/* ---------------- 搜索结果（选一部添加）---------------- */}
        {candidates ? (
          <div className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium text-ink-700">选择要追的番剧</span>
              <button
                type="button"
                onClick={() => setCandidates(null)}
                className="text-xs text-ink-500 hover:text-ink-700"
              >
                取消
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {candidates.map((c) => (
                <div key={c.subject_id} className="surface overflow-hidden">
                  <div className="aspect-[3/4] w-full bg-slate-100">
                    {c.cover_url ? (
                      <img
                        src={c.cover_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5 p-2">
                    <div className="line-clamp-2 text-xs font-medium text-ink-900" title={c.title}>
                      {c.title}
                    </div>
                    <div className="truncate text-[11px] text-ink-500">
                      {c.latest_label || c.status || '—'}
                    </div>
                    <button
                      type="button"
                      disabled={c.followed}
                      onClick={() => void handleAdd(c)}
                      className={c.followed ? 'btn-ghost !py-1 !text-xs' : 'btn-primary !py-1 !text-xs'}
                    >
                      {c.followed ? '已追' : '添加'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="surface mb-4 p-6 text-center">
            <p className="text-sm text-ink-700">{error}</p>
            <button type="button" onClick={() => void load()} className="btn-primary mt-3">
              重试
            </button>
          </div>
        ) : null}

        {/* ---------------- 左右两栏：列表 + 详情 ---------------- */}
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* 左：追番列表 */}
          <div className="lg:w-[420px] lg:shrink-0">
            <div className="mb-2 flex items-center gap-2 text-xs text-ink-500">
              <span>共 {follows.length} 部</span>
              {checking ? <span>· 检测更新中…</span> : null}
            </div>

            {loading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="surface h-[78px] animate-pulse" />
                ))}
              </div>
            ) : follows.length === 0 ? (
              <div className="surface px-5 py-10 text-center">
                <div className="mb-2 text-3xl opacity-30">📺</div>
                <p className="text-sm text-ink-700">还没有追番</p>
                <p className="mt-1 text-xs text-ink-500">在上面搜索番剧名添加</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {follows.map((f) => (
                  <div
                    key={f.id}
                    className={`surface flex cursor-pointer gap-3 p-2.5 transition-colors hover:border-ink-300
                                ${viewing?.id === f.id ? 'ring-2 ring-bilibili/40' : ''}`}
                    onClick={() => setViewing(f)}
                  >
                    <div className="h-[62px] w-[46px] shrink-0 overflow-hidden rounded-md bg-slate-100">
                      {f.cover_url ? (
                        <img
                          src={f.cover_url}
                          alt=""
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
                      <div className="flex items-start gap-1.5">
                        <span className="line-clamp-2 flex-1 text-xs font-medium text-ink-900">
                          {f.title}
                        </span>
                        {f.has_update ? (
                          <span className={`chip shrink-0 !px-1.5 !py-0.5 !text-[10px] ${UPDATE_BADGE}`}>
                            新
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-ink-500">
                        <span>看到 {f.watched_eps}</span>
                        <span className="text-ink-300">/</span>
                        <span>{f.latest_label || `最新 ${f.latest_eps} 话`}</span>
                        <div className="flex-1" />
                        {f.has_update ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleWatched(f)
                            }}
                            className="rounded-md border border-ink-100 px-1.5 py-0.5 text-[10px]
                                       text-ink-700 transition-colors hover:border-ink-300"
                          >
                            已看
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleRemove(f)
                          }}
                          className="rounded-md px-1 py-0.5 text-[10px] text-ink-300 transition-colors hover:text-red-500"
                          title="删除追番"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右：详情（同源代理的 agedm 页面） */}
          <div className="surface min-h-[520px] flex-1 overflow-hidden lg:sticky lg:top-[62px] lg:h-[calc(100vh-88px)]">
            {renderFrame(viewing)}
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-ink-300">
          番剧数据来自 AGE 动漫（agedm.io）。播放请在站内进行——播放器无法嵌入本应用。
        </p>
      </main>
    </div>
  )
}