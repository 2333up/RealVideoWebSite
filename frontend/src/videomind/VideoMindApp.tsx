import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
// ReactFlow 的基础布局样式（节点定位、边、缩放控件）。融合后由这里引入，
// 不再有独立的 main.tsx 负责。
import '@xyflow/react/dist/style.css'
import { api } from './api'
import type {
  Chapter,
  Folder,
  Job,
  MindMapNode,
  PickerInfo,
  VideoDetail,
  VideoSummary,
} from './types'
import VideoPlayer from './components/VideoPlayer'
import ChapterList from './components/ChapterList'
import MindMap from './components/MindMap'
import Transcript from './components/Transcript'
import SettingsPanel from './components/SettingsPanel'
import UsagePanel from './components/UsagePanel'
import ImportPanel from './components/ImportPanel'
import FolderList from './components/FolderList'
import PanelResizer from './components/PanelResizer'
import PanelRail from './components/PanelRail'
import { makeSeekRequest, type SeekRequest } from './lib/seekRequest'
import { formatElapsed } from './lib/format'

export default function App() {
  // videos 始终是全量：分类树按 folder_id 就地分组渲染，不再按当前分类
  // 另向后端要一份过滤结果——否则每切一次分类都要重新请求，且展开别的分类时
  // 手里根本没有那份数据。
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  /**
   * 当前分类。默认停在「未分类」('none')：它是所有新导入视频的落点，
   * 打开就应该看到东西。没有「全部」这一档——视频按分类归位后再横着拉一张
   * 全量列表，只会让「这个视频到底属于哪个分类」变得模糊。
   */
  const [activeFolder, setActiveFolder] = useState('none')
  const [pickerInfo, setPickerInfo] = useState<PickerInfo | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<VideoDetail | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyHint, setBusyHint] = useState('')
  const [rightTab, setRightTab] = useState<'mindmap' | 'transcript'>('mindmap')
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)
  /**
   * 分析刚刚结束的回执。
   *
   * 只在「状态从 processing 翻到 ready/failed」的那一刻产生：
   * 直接看 detail.status === 'ready' 是不行的——刷新页面、切回这个视频
   * 都会看到 ready，那就变成每次都弹一次「分析完成」。
   */
  const [finishNotice, setFinishNotice] = useState<{ ok: boolean; seconds: number | null } | null>(
    null,
  )
  const prevStatusRef = useRef<string | null>(null)
  // 左右侧栏宽度与折叠状态。默认值从 localStorage 取，
  // 这样用户调好的布局在下次打开时还在——调过一次的东西不该每次重来。
  const [leftWidth, setLeftWidth] = useState(() => loadLayout().leftWidth)
  const [rightWidth, setRightWidth] = useState(() => loadLayout().rightWidth)
  const [leftOpen, setLeftOpen] = useState(() => loadLayout().leftOpen)
  const [rightOpen, setRightOpen] = useState(() => loadLayout().rightOpen)

  const playerRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    saveLayout({ leftWidth, rightWidth, leftOpen, rightOpen })
  }, [leftWidth, rightWidth, leftOpen, rightOpen])

  // ---------------------------------------------------------------- 数据加载

  const refresh = useCallback(async () => {
    try {
      const [all, folders] = await Promise.all([api.listVideos(), api.listFolders()])
      setVideos(all.items)
      setFolders(folders.items)
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }, [])

  useEffect(() => {
    refresh()
    // 能力探测失败不该挡住列表：pickerInfo 为 null 时前端按「不可用」渲染
    api
      .pickerInfo()
      .then(setPickerInfo)
      .catch(() => setPickerInfo(null))
  }, [refresh])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    api
      .getVideo(selectedId)
      .then(setDetail)
      .catch((e) => setError(String((e as Error).message || e)))
  }, [selectedId])

  // ---------------------------------------------------------------- 任务轮询

  const pollJob = useCallback(async () => {
    if (!selectedId) return
    try {
      const r = await api.listVideos()
      setVideos(r.items)
      const v = r.items.find((x) => x.id === selectedId)
      if (!v) return
      if (v.status === 'ready' || v.status === 'failed') {
        setJob(null)
        const d = await api.getVideo(selectedId)
        setDetail(d)
        if (d.status === 'failed') setError(d.error || '处理失败')
      } else if (v.status === 'processing') {
        // 后端没有「按视频查当前任务」的接口，这里用列表里的状态驱动重取详情
        const d = await api.getVideo(selectedId)
        setDetail(d)
      }
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }, [selectedId])

  useEffect(() => {
    if (detail?.status !== 'processing') return
    const timer = setInterval(pollJob, 2000)
    return () => clearInterval(timer)
  }, [detail?.status, pollJob])

  // 切视频时抹掉上一支的分析记忆，否则会看到「A 视频的分析完成了」挂在 B 视频上
  useEffect(() => {
    prevStatusRef.current = null
    setFinishNotice(null)
  }, [selectedId])

  useEffect(() => {
    const status = detail?.status ?? null
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev === 'processing' && (status === 'ready' || status === 'failed')) {
      setFinishNotice({
        ok: status === 'ready',
        seconds: detail?.last_job?.elapsed_seconds ?? null,
      })
    }
  }, [detail?.status, detail?.last_job?.elapsed_seconds])

  // 回执自动消失，但不自动消失的才叫通知；给足 12 秒够看清耗时了
  useEffect(() => {
    if (!finishNotice) return
    const timer = setTimeout(() => setFinishNotice(null), 12000)
    return () => clearTimeout(timer)
  }, [finishNotice])

  // ---------------------------------------------------------------- 交互

  const chapterScrollRef = useRef<HTMLDivElement>(null)

  /**
   * 把包含时间点 t 的章节滚进可视区。
   *
   * 章节区独立滚动之后，从导图点节点时目标章节可能远在视口之外——
   * 视频跳过去了、章节列表却还停在原地，用户会以为是联动失灵。
   * block:'nearest' 是刻意的：章节本来就在视野里时它一动不动，
   * 只有真的看不见才滚，避免点一次跳一下的抽搐感。
   */
  const scrollChapterIntoView = useCallback(
    (t: number) => {
      const box = chapterScrollRef.current
      const list = detail?.chapters ?? []
      if (!box || list.length === 0) return
      const hit =
        list.find((c) => t >= c.start - 0.01 && t < c.end) ??
        // 时间点落在章节缝隙里时，退回「最后一个不晚于 t 的章节」
        [...list].reverse().find((c) => c.start <= t) ??
        list[0]
      const el = box.querySelector<HTMLElement>(`[data-chapter-id="${hit.id}"]`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    },
    [detail],
  )

  /**
   * 三向联动的终点：章节、导图、逐字稿的点击全部汇聚到这里。
   *
   * 这里不直接操作 DOM，而是发一个带唯一 ID 的跳转请求，
   * 由 VideoPlayer 负责真正执行（它才知道 metadata 是否就绪）。
   * 传 endSeconds 时，播放器会在该时刻自动暂停——「播放本章」变成一个完整动作。
   */
  const seekTo = useCallback(
    (t: number, endT?: number | null) => {
      if (!Number.isFinite(t)) return
      setSeekRequest(makeSeekRequest(t, endT ?? null))
      scrollChapterIntoView(t)
    },
    [scrollChapterIntoView],
  )

  // ---------------------------------------------------------------- 导入

  /**
   * 导入后的落点固定是「未分类」。
   *
   * 之前是「落到当前正在看的分类」，听起来贴心，实际有两个毛病：
   *   1. 站在 A 分类里导入，东西直接沉进 A，用户根本没机会决定它该不该在这
   *      ——分类的价值就在于**事后**整理，导入时替用户做决定等于取消了这一步；
   *   2. 站在别处导入时，新视频出现在看不见的地方，像是没导进来。
   * 统一先进未分类，再由用户拖走，路径才闭合。
   */
  const IMPORT_FOLDER_ID: number | null = null

  const formatFailures = (failed: { path: string; reason: string }[], limit = 3) => {
    const head = failed
      .slice(0, limit)
      .map((f) => `${f.path.split(/[\\/]/).pop()}：${f.reason}`)
      .join('\n')
    return failed.length > limit
      ? `${head}\n……共 ${failed.length} 个文件导入失败`
      : head
  }

  const doImportFiles = async (paths: string[]) => {
    setBusy(true)
    setBusyHint(`正在导入 ${paths.length} 个文件…`)
    setError('')
    try {
      const r = await api.importMany(paths, IMPORT_FOLDER_ID)
      await refresh()
      // 落点是未分类，就把视图也切过去：否则新视频在看不见的地方，像是没导进来
      if (r.items.length) {
        setActiveFolder('none')
        if (selectedId === null) setSelectedId(r.items[0].id)
      }
      if (r.failed.length) setError(formatFailures(r.failed))
      else if (r.created === 0 && r.duplicates > 0) setError('这些视频之前已经导入过了')
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
      setBusyHint('')
    }
  }

  const doImportFolder = async (dir: string) => {
    setBusy(true)
    setBusyHint('正在扫描文件夹…')
    setError('')
    try {
      // create_folder=false：不再按目录名自动建分类。
      // 整目录导入同样先进未分类，保持「导入一律先落地，整理交给人」这一条规则。
      const r = await api.importFolder(dir, { recursive: true, create_folder: false })
      await refresh()
      if (r.imported_ids.length) {
        setActiveFolder('none')
        setSelectedId(r.imported_ids[0])
      }
      if (r.failed.length) setError(formatFailures(r.failed))
      else if (r.created === 0 && r.duplicates > 0) setError('该目录下的视频都已导入过')
      else if (r.message) setError(r.message)
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
      setBusyHint('')
    }
  }

  const doImport = async (path: string) => {
    setBusy(true)
    setError('')
    try {
      const r = await api.importVideo(path, IMPORT_FOLDER_ID)
      await refresh()
      setActiveFolder('none')
      setSelectedId(r.id)
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 分类文件夹

  const createFolder = async (name: string, parentId: number | null = null) => {
    setError('')
    try {
      await api.createFolder(name, parentId)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const renameFolder = async (id: number, name: string) => {
    setError('')
    try {
      await api.renameFolder(id, name)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const removeFolder = async (id: number) => {
    setError('')
    try {
      await api.deleteFolder(id)
      // 正在看被删的分类时自动回到「未分类」——删除会把视频退回未分类，
      // 界面跟着切过去，用户才知道东西去哪了
      if (activeFolder === String(id)) setActiveFolder('none')
      await refresh()
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const moveVideo = async (videoId: number, folderId: number | null) => {
    setError('')
    try {
      await api.assignVideos([videoId], folderId)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  // ---------------------------------------------------------------- 章节 / 导图编辑

  /** 重新拉详情：章节与导图互相影响，局部合并很容易漏掉一边 */
  const reloadDetail = async (videoId: number) => {
    const d = await api.getVideo(videoId)
    setDetail(d)
    return d
  }

  const saveMindmap = async (tree: MindMapNode) => {
    if (!detail) return
    try {
      const r = await api.patchMindmap(detail.id, tree)
      // 用后端返回的树为准：它做过清洗（补 id、夹取时间戳），
      // 前端本地的乐观值可能与之不一致，直接覆盖可避免「看着存了其实没存」
      setDetail({ ...detail, mindmap: r.tree, chapters: r.chapters })
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const addChapter = async () => {
    if (!detail) return
    try {
      await api.addChapter(detail.id, { title: '新章节', start: currentTime })
      await reloadDetail(detail.id)
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const patchChapter = async (chapterId: number, patch: Partial<Chapter>) => {
    if (!detail) return
    try {
      const r = await api.patchChapter(detail.id, chapterId, patch)
      setDetail({
        ...detail,
        chapters: detail.chapters.map((c) => (c.id === chapterId ? r.chapter : c)),
      })
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const removeChapter = async (chapterId: number) => {
    if (!detail) return
    try {
      await api.deleteChapter(detail.id, chapterId)
      // 删的若是由导图节点生成的章节，后端会清掉该节点时间戳 -> 导图也变了
      await reloadDetail(detail.id)
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const startAnalysis = async (videoId: number, force = false) => {
    setError('')
    try {
      const r = await api.startJob(videoId, force)
      setJob({ ...(await api.getJob(r.job_id)) })
      await refresh()
      setSelectedId(videoId)
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  // ---------------------------------------------------------------- 渲染

  return (
    // vm-root：见 videomind.css，把原 body 的配色与字体收敛到这里，
    // 避免和 lingoSeek 路由的全局样式互相覆盖。
    <div className="vm-root h-full flex flex-col">
      {/* 顶栏 */}
      <header className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center shrink-0">
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="text-[11px] text-gray-400 hover:text-blue-600 transition-colors"
            title="返回灵搜 LingoSeek 视频搜索"
          >
            ← 灵搜
          </Link>
          <span className="text-base font-semibold text-gray-900">video-mind</span>
          <span className="text-[11px] text-gray-400">本地视频 · 章节 · 思维导图</span>
        </div>
        <button
          onClick={() => setShowUsage(true)}
          className="ml-auto text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          用量
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="ml-2 text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          设置
        </button>
      </header>

      {error && (
        <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2 flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-700">
            ×
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* 左：导入 + 分类 + 视频列表。宽度可拖，可一键折叠。 */}
        {leftOpen ? (
          <>
            <aside
              style={{ width: leftWidth }}
              className="bg-white border-r border-gray-200 flex flex-col shrink-0"
            >
              <div className="px-3 py-1.5 border-b border-gray-100 flex items-center shrink-0">
                <span className="text-[11px] text-gray-500">视频库</span>
                <button
                  onClick={() => setLeftOpen(false)}
                  title="折叠左侧栏"
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                >
                  «
                </button>
              </div>

              <ImportPanel
                pickerAvailable={pickerInfo?.available ?? false}
                pickerReason={pickerInfo?.reason ?? ''}
                busy={busy}
                busyHint={busyHint}
                onPickFiles={doImportFiles}
                onPickFolder={doImportFolder}
                onPastePath={doImport}
              />

              <FolderList
                folders={folders}
                videos={videos}
                active={activeFolder}
                selectedId={selectedId}
                unfiledCount={videos.filter((v) => v.folder_id === null).length}
                onSelect={setActiveFolder}
                onCreate={createFolder}
                onRename={renameFolder}
                onDelete={removeFolder}
                onDropVideo={moveVideo}
                onSelectVideo={setSelectedId}
                onAnalyze={startAnalysis}
                onMove={moveVideo}
              />
            </aside>

            <PanelResizer
              label="调整视频库宽度"
              onDelta={(dx) => setLeftWidth((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX))}
              onToggle={() => setLeftOpen(false)}
            />
          </>
        ) : (
          <PanelRail side="left" label="视频库" onExpand={() => setLeftOpen(true)} />
        )}

        {/*
          中：播放器 + 章节。
          两块**不共用**滚动容器：播放器吸在顶部（shrink-0）不动，
          章节自己滚。之前整栏一起滚，往下滑几章播放器就消失了——
          而「边看视频边翻章节」正是这里最主要的使用方式。
        */}
        <main className="flex-1 min-w-0 flex flex-col min-h-0">
          {!detail ? (
            <EmptyState />
          ) : (
            <>
              <div className="shrink-0 px-4 pt-4 pb-3 space-y-3">
                <VideoPlayer
                video={detail}
                playerRef={playerRef}
                seekRequest={seekRequest}
                onTimeUpdate={setCurrentTime}
              />

              {/* 进度条区 */}
              {detail.status === 'processing' && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between text-xs text-blue-900 mb-2">
                    <span className="font-medium">
                      {STAGE_LABELS[job?.stage ?? ''] ?? '处理中…'}
                    </span>
                    <span className="tabular-nums">每 2 秒自动刷新</span>
                  </div>
                  {job?.message && (
                    <p className="text-[11px] text-blue-700 mb-2">{job.message}</p>
                  )}
                  <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <p className="text-[10px] text-blue-600 mt-2 leading-relaxed">
                    长视频转写较慢（1 小时视频 GPU 上约需 5-15 分钟），
                    可以切到别的视频，处理在后台继续。
                  </p>
                </div>
              )}

              {detail.status === 'failed' && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                  <div className="text-xs font-medium text-red-800 mb-1">处理失败</div>
                  <p className="text-[11px] text-red-700 whitespace-pre-wrap">{detail.error}</p>
                  <button
                    onClick={() => startAnalysis(detail.id, true)}
                    className="mt-2 text-[11px] px-2.5 py-1 rounded border border-red-300 text-red-700 hover:bg-red-100"
                  >
                    重试
                  </button>
                </div>
              )}

              {detail.status === 'pending' && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-6 text-center">
                  <p className="text-sm text-gray-600 mb-3">尚未分析</p>
                  <button
                    onClick={() => startAnalysis(detail.id)}
                    className="px-4 py-2 rounded bg-blue-600 text-white text-xs hover:bg-blue-500"
                  >
                    开始分析
                  </button>
                </div>
              )}
              </div>

              {/* 以下是可滚动区：章节会一直往下排，播放器留在上面不动 */}
              <div
                ref={chapterScrollRef}
                className="flex-1 min-h-0 overflow-y-auto thin-scroll px-4 pb-4 space-y-3"
              >
              {/* 本次分析的模型用量：分析的直接成本，必须让用户随手可见，
                  而不是藏在设置页里。点「用量」看全局明细。 */}
              {detail.token_usage && detail.token_usage.calls > 0 && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-2.5 flex items-center flex-wrap gap-x-4 gap-y-1">
                  <span className="text-[11px] text-gray-500">模型用量</span>
                  <span className="text-[11px] text-gray-700 tabular-nums">
                    合计{' '}
                    <b className="text-gray-900">{detail.token_usage.total_tokens.toLocaleString('zh-CN')}</b>{' '}
                    tokens
                  </span>
                  <span className="text-[11px] text-gray-500 tabular-nums">
                    输入 {detail.token_usage.prompt_tokens.toLocaleString('zh-CN')} · 输出{' '}
                    {detail.token_usage.completion_tokens.toLocaleString('zh-CN')}
                  </span>
                  <span className="text-[11px] text-gray-500 tabular-nums">
                    {detail.token_usage.calls} 次调用
                  </span>
                  <button
                    onClick={() => setShowUsage(true)}
                    className="ml-auto text-[11px] text-blue-600 hover:underline"
                  >
                    查看全部用量 →
                  </button>
                </div>
              )}

              {detail.chapters.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
                    章节
                    <span className="text-[11px] font-normal text-gray-400">
                      点击任意章节跳转到对应时间；点导图节点会自动滚到这里
                    </span>
                  </h2>
                  <ChapterList
                    chapters={detail.chapters}
                    currentTime={currentTime}
                    onSeek={(t, end) => seekTo(t, end)}
                    onAdd={addChapter}
                    onPatch={patchChapter}
                    onDelete={removeChapter}
                  />
                </section>
              )}
              </div>
            </>
          )}
        </main>

        {/* 右：思维导图 / 逐字稿。宽度可拖、可一键折叠——
            导图默认只有 420px，看大树时确实憋屈，所以这两块都要能自由放大。 */}
        {rightOpen ? (
          <>
            <PanelResizer
              label="调整导图区宽度"
              onDelta={(dx) => setRightWidth((w) => clamp(w - dx, RIGHT_MIN, rightMax()))}
              onToggle={() => setRightOpen(false)}
            />
            <aside
              style={{ width: rightWidth }}
              className="bg-white border-l border-gray-200 flex flex-col shrink-0"
            >
              {!detail ? (
                <div className="text-xs text-gray-400 text-center py-8">选择视频后显示</div>
              ) : (
                <>
                  <div className="flex border-b border-gray-200 shrink-0">
                    {(
                      [
                        ['mindmap', '思维导图'],
                        ['transcript', '逐字稿'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setRightTab(key)}
                        className={[
                          'flex-1 px-3 py-2 text-xs font-medium transition',
                          rightTab === key
                            ? 'text-blue-600 border-b-2 border-blue-600'
                            : 'text-gray-500 hover:text-gray-800',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      onClick={() => setRightOpen(false)}
                      title="折叠右侧栏"
                      className="px-2 text-[11px] text-gray-400 hover:text-gray-700 hover:bg-gray-50"
                    >
                      »
                    </button>
                  </div>

                  {/*
                    分析回执横幅：跑十几分钟的任务不给回执，
                    用户不知道是成功了还是要重来。
                  */}
                  {finishNotice && (
                    <div
                      className={[
                        'shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] border-b',
                        finishNotice.ok
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                          : 'bg-red-50 border-red-200 text-red-800',
                      ].join(' ')}
                    >
                      <span className="shrink-0">
                        {finishNotice.ok ? '分析完成' : '分析失败'}
                      </span>
                      {finishNotice.ok && finishNotice.seconds !== null && (
                        <span className="tabular-nums">
                          耗时 {formatElapsed(finishNotice.seconds)}
                        </span>
                      )}
                      <span className="flex-1" />
                      <button
                        onClick={() => setFinishNotice(null)}
                        className="shrink-0 px-1 text-gray-400 hover:text-gray-800"
                        title="关闭提示"
                      >
                        ×
                      </button>
                    </div>
                  )}

                  {/*
                    遮罩挂在右栏这一层，而不是塞进 MindMap 组件里：
                    首次分析时导图还不存在，App 里走的是「分析完成后自动生成」占位分支，
                    MindMap 根本没被渲染——那恰恰是最需要提示的时刻。
                  */}
                  <div className="relative flex-1 min-h-0 p-3">
                    <div
                      className={[
                        'w-full h-full transition',
                        detail.status === 'processing'
                          ? 'grayscale opacity-60 pointer-events-none select-none'
                          : '',
                      ].join(' ')}
                    >
                      {rightTab === 'mindmap' ? (
                        detail.mindmap ? (
                          <MindMap
                            tree={detail.mindmap}
                            videoId={detail.id}
                            currentTime={currentTime}
                            onSeek={seekTo}
                            onSaveTree={saveMindmap}
                          />
                        ) : (
                          <div className="text-xs text-gray-400 text-center py-8">
                            {detail.status === 'ready'
                              ? '暂无思维导图'
                              : '分析完成后自动生成思维导图'}
                          </div>
                        )
                      ) : detail.transcript ? (
                        <Transcript
                          segments={detail.transcript.segments}
                          currentTime={currentTime}
                          onSeek={seekTo}
                        />
                      ) : (
                        <div className="text-xs text-gray-400 text-center py-8">暂无转写内容</div>
                      )}
                    </div>

                    {detail.status === 'processing' && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center">
                        <div className="w-[82%] max-w-[330px] rounded-lg border border-gray-200 bg-white shadow-lg px-4 py-3.5">
                          <div className="flex items-center gap-2 mb-2.5">
                            <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
                            <span className="text-[13px] font-medium text-gray-800">
                              正在分析中…
                            </span>
                          </div>

                          <div className="text-[11px] text-gray-600 mb-2.5">
                            {STAGE_LABELS[detail.last_job?.stage ?? ''] ?? '准备中…'}
                            {detail.last_job?.message ? ` · ${detail.last_job.message}` : ''}
                          </div>

                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 rounded-full transition-all duration-500"
                              style={{ width: `${Math.max(4, detail.last_job?.progress ?? 0)}%` }}
                            />
                          </div>

                          <div className="mt-2 flex items-center text-[11px] text-gray-500">
                            <span className="tabular-nums">
                              已用时{' '}
                              {detail.last_job?.elapsed_seconds != null
                                ? formatElapsed(detail.last_job.elapsed_seconds)
                                : '—'}
                            </span>
                            <span className="ml-auto">{detail.last_job?.progress ?? 0}%</span>
                          </div>

                          <p className="mt-2.5 text-[10px] text-gray-400 leading-relaxed">
                            长视频转写较慢（1 小时视频 GPU 上约需 5-15 分钟），
                            可以切到别的视频，处理在后台继续。
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </aside>
          </>
        ) : (
          <PanelRail side="right" label="思维导图" onExpand={() => setRightOpen(true)} />
        )}
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showUsage && <UsagePanel onClose={() => setShowUsage(false)} />}
    </div>
  )
}

// ------------------------------------------------------------------ 布局状态

const LAYOUT_KEY = 'video-mind:layout.v1'

/** 侧栏宽度的下限：再窄按钮和文件名就挤成一团了 */
const LEFT_MIN = 200
const LEFT_MAX = 560
const RIGHT_MIN = 300
// 右栏默认 460：导图改成中心发散后，左右两个方向都要横向空间，
// 420 会把两侧分支压得只剩标签头几个字。
const DEFAULT_LAYOUT = { leftWidth: 256, rightWidth: 460, leftOpen: true, rightOpen: true }

type LayoutState = typeof DEFAULT_LAYOUT

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    return {
      leftWidth: clamp(Number(parsed.leftWidth) || DEFAULT_LAYOUT.leftWidth, LEFT_MIN, LEFT_MAX),
      // 上限按当前窗口算：上次在 4K 屏上把右栏拉到 1200，
      // 这次在小窗口打开就会把中间播放区挤没
      rightWidth: clamp(
        Number(parsed.rightWidth) || DEFAULT_LAYOUT.rightWidth,
        RIGHT_MIN,
        rightMax(),
      ),
      leftOpen: parsed.leftOpen !== false,
      rightOpen: parsed.rightOpen !== false,
    }
  } catch {
    // 存档损坏就用默认值，不该因为一个坏掉的 JSON 让整个界面打不开
    return DEFAULT_LAYOUT
  }
}

function saveLayout(state: LayoutState): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(state))
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

/** 右栏上限：给中间播放区至少留 420px，否则视频小得没法看 */
function rightMax(): number {
  return Math.max(RIGHT_MIN, (typeof window === 'undefined' ? 1440 : window.innerWidth) - 420)
}

// ------------------------------------------------------------------ 小组件

const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  extract_audio: '抽取音频',
  transcribe: '语音转写',
  chapter: '智能分章节',
  mindmap: '生成思维导图',
  done: '完成',
  failed: '失败',
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">🎬</div>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">把长视频变成可导航的知识地图</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-4">
          导入本地视频后，自动完成语音转写、智能分章节与思维导图生成。
          点击导图的任意节点或章节卡片，播放器立刻跳到对应的时间点。
        </p>
        <ol className="text-xs text-gray-400 text-left space-y-1.5 bg-gray-50 rounded-lg p-4">
          <li>① 点左侧「选择视频文件导入」，或「选择文件夹批量导入」</li>
          <li>② 导入后可拖到左侧任意分类里，或「＋ 新建」一个分类</li>
          <li>③ 进入「设置」配置大模型 API Key（推荐 DeepSeek）</li>
          <li>④ 点击「开始分析」，等待转写与章节生成</li>
          <li>⑤ 在右侧思维导图上点击节点即可跳转播放</li>
        </ol>
      </div>
    </div>
  )
}
