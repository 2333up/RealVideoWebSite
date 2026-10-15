import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Folder, Job, PickerInfo, VideoDetail, VideoSummary } from './types'
import VideoPlayer from './components/VideoPlayer'
import ChapterList from './components/ChapterList'
import MindMap from './components/MindMap'
import Transcript from './components/Transcript'
import SettingsPanel from './components/SettingsPanel'
import UsagePanel from './components/UsagePanel'
import ImportPanel from './components/ImportPanel'
import FolderList from './components/FolderList'
import VideoList from './components/VideoList'
import { makeSeekRequest, type SeekRequest } from './lib/seekRequest'

export default function App() {
  const [videos, setVideos] = useState<VideoSummary[]>([])
  // 全量列表单独存一份：侧栏要显示「全部 / 未分类」的真实计数，
  // 而 videos 是当前分类过滤后的结果，两者不是一回事。
  const [allVideos, setAllVideos] = useState<VideoSummary[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [activeFolder, setActiveFolder] = useState('')
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

  const playerRef = useRef<HTMLVideoElement>(null)

  // ---------------------------------------------------------------- 数据加载

  const refresh = useCallback(async () => {
    try {
      const [all, folders, scoped] = await Promise.all([
        api.listVideos(),
        api.listFolders(),
        activeFolder ? api.listVideos(activeFolder) : Promise.resolve(null),
      ])
      setAllVideos(all.items)
      setFolders(folders.items)
      setVideos(scoped ? scoped.items : all.items)
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }, [activeFolder])

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
      const r = await api.listVideos(activeFolder || undefined)
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
  }, [selectedId, activeFolder])

  useEffect(() => {
    if (detail?.status !== 'processing') return
    const timer = setInterval(pollJob, 2000)
    return () => clearInterval(timer)
  }, [detail?.status, pollJob])

  // ---------------------------------------------------------------- 交互

  /**
   * 三向联动的终点：章节、导图、逐字稿的点击全部汇聚到这里。
   *
   * 这里不直接操作 DOM，而是发一个带唯一 ID 的跳转请求，
   * 由 VideoPlayer 负责真正执行（它才知道 metadata 是否就绪）。
   * 传 endSeconds 时，播放器会在该时刻自动暂停——「播放本章」变成一个完整动作。
   */
  const seekTo = useCallback((t: number, endT?: number | null) => {
    if (!Number.isFinite(t)) return
    setSeekRequest(makeSeekRequest(t, endT ?? null))
  }, [])

  // ---------------------------------------------------------------- 导入

  /** 当前分类作为「导入后归入哪里」的默认值：从某个分类里点导入，结果就该进那个分类 */
  const targetFolderId = useMemo<number | null>(() => {
    const n = Number(activeFolder)
    return Number.isFinite(n) && String(n) === activeFolder ? n : null
  }, [activeFolder])

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
      const r = await api.importMany(paths, targetFolderId)
      await refresh()
      if (r.items.length && selectedId === null) setSelectedId(r.items[0].id)
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
      const r = await api.importFolder(dir, { recursive: true, create_folder: true })
      await refresh()
      // 自动切到刚建好的分类：用户看到「东西已经归好位了」，而不是散在全量列表里
      if (r.folder) setActiveFolder(String(r.folder.id))
      if (r.imported_ids.length) setSelectedId(r.imported_ids[0])
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
      const r = await api.importVideo(path, targetFolderId)
      await refresh()
      setSelectedId(r.id)
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 分类文件夹

  const createFolder = async (name: string) => {
    setError('')
    try {
      await api.createFolder(name)
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
      // 正在看被删的分类时自动回到「全部」，否则界面会空得莫名其妙
      if (activeFolder === String(id)) setActiveFolder('')
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
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <header className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center shrink-0">
        <div className="flex items-center gap-2">
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
        {/* 左：导入 + 分类 + 视频列表 */}
        <aside className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0">
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
            active={activeFolder}
            totalCount={allVideos.length}
            unfiledCount={allVideos.filter((v) => v.folder_id === null).length}
            onSelect={setActiveFolder}
            onCreate={createFolder}
            onRename={renameFolder}
            onDelete={removeFolder}
            onDropVideo={moveVideo}
          />

          <VideoList
            videos={videos}
            selectedId={selectedId}
            folders={folders}
            onSelect={setSelectedId}
            onAnalyze={startAnalysis}
            onMove={moveVideo}
          />
        </aside>

        {/* 中：播放器 + 章节 */}
        <main className="flex-1 overflow-y-auto thin-scroll p-4">
          {!detail ? (
            <EmptyState />
          ) : (
            <div className="space-y-4">
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
                      点击任意章节跳转到对应时间
                    </span>
                  </h2>
                  <ChapterList
                    chapters={detail.chapters}
                    currentTime={currentTime}
                    onSeek={(t, end) => seekTo(t, end)}
                  />
                </section>
              )}
            </div>
          )}
        </main>

        {/* 右：思维导图 / 逐字稿 */}
        <aside className="w-[420px] bg-white border-l border-gray-200 flex flex-col shrink-0">
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
              </div>

              <div className="flex-1 min-h-0 p-3">
                {rightTab === 'mindmap' ? (
                  detail.mindmap ? (
                    <MindMap tree={detail.mindmap} currentTime={currentTime} onSeek={seekTo} />
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
            </>
          )}
        </aside>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showUsage && <UsagePanel onClose={() => setShowUsage(false)} />}
    </div>
  )
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
