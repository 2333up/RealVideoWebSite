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
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CloseIcon,
  IconButton,
  MIN_TAPPABLE,
  VideoIcon,
} from './components/icons'
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
  // 左栏当前 tab：视频库 / 章节。章节搬到左栏后，两边是「看」和「管」的分工，
  // 不必跨会话记住——每次进来先看库更自然。
  const [leftTab, setLeftTab] = useState<'library' | 'chapters'>('library')
  /** 失败红框的展开/收起：默认展开，收起后只剩一行，不再霸占空间 */
  const [failExpanded, setFailExpanded] = useState(true)
  /** 「按区间重写摘要」正在进行：按钮置灰，防止连点重复花钱 */
  const [rewriting, setRewriting] = useState(false)

  const playerRef = useRef<HTMLVideoElement>(null)

  /**
   * 左栏是否处于「宽」形态。
   *
   * 行高、字号、要不要把体积摊到右边，都跟着这个开关走。阈值取 420：
   * 再窄就还是「尽量多塞几条」的密集模式，再宽就该把空间用起来。
   */
  const leftWide = leftWidth >= 420

  useEffect(() => {
    saveLayout({ leftWidth, rightWidth, leftOpen, rightOpen })
  }, [leftWidth, rightWidth, leftOpen, rightOpen])

  // 换视频时把失败框恢复展开：上一个视频收起了，不该让下一个也默认藏着原因
  useEffect(() => {
    setFailExpanded(true)
  }, [selectedId])

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

  /**
   * 按每一章自己的时间区间，用该区间的原文重写摘要与要点。
   *
   * 为什么要手动触发而不是每次自动：一次请求背后是「每章一次模型调用」，
   * 16 章的课要打十几次，花钱又慢——适合「整理完时间轴之后按一下」，
   * 不适合每次打开都跑。
   */
  const rewriteSummaries = async () => {
    if (!detail) return
    if (!detail.transcript) {
      setError('这支视频还没有转写结果，无法按区间重写摘要')
      return
    }
    const n = detail.chapters.length
    if (
      !confirm(
        `用每章自己时间区间内的原文，重写全部 ${n} 条摘要与要点？\n\n` +
          `会覆盖现在的内容，并消耗 ${n} 次左右的模型调用。`,
      )
    ) {
      return
    }
    setRewriting(true)
    setError('')
    try {
      const r = await api.rewriteChapterSummaries(detail.id)
      await reloadDetail(detail.id)
      if (r.errors.length) {
        setError(`${r.errors.length} 条没写成：\n${r.errors.slice(0, 3).join('\n')}`)
      } else if (r.skipped > 0) {
        setError(`已重写 ${r.updated} 条；${r.skipped} 条区间内没有可用的原文，保持原样`)
      }
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setRewriting(false)
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
      {/* 顶栏：只放身份和两个次要入口，不该占掉画面高度。
          py-1.5 + 24px 按钮 = 约 36px（原来 50px），省下来的全留给播放器 */}
      <header className="bg-white border-b border-gray-200 px-4 py-1.5 flex items-center shrink-0">
        <div className="flex items-center gap-1.5">
          <Link
            to="/"
            className="inline-flex items-center min-h-[24px] px-1 -mx-1 rounded text-[10px] text-gray-400 hover:text-blue-600 hover:bg-gray-50 transition-colors"
            title="返回灵搜 LingoSeek 视频搜索"
          >
            <span className="mr-0.5">←</span>灵搜
          </Link>
          <span className="text-[13px] font-semibold text-gray-900 leading-none">video-mind</span>
          <span className="text-[10px] text-gray-400 leading-none">本地视频 · 章节 · 思维导图</span>
        </div>
        <button
          onClick={() => setShowUsage(true)}
          className={`ml-auto text-[11px] px-2.5 rounded border border-gray-300 hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          用量
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className={`ml-1.5 text-[11px] px-2.5 rounded border border-gray-300 hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          设置
        </button>
      </header>

      {error && (
        <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2 flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <IconButton
            icon={<CloseIcon size={16} />}
            label="关闭错误提示"
            onClick={() => setError('')}
            className="text-red-400 hover:text-red-700 hover:bg-red-100"
          />
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/*
          左：视频库 / 章节 两个 tab。
          章节从中间栏搬过来是有意为之：原来「上面视频 + 下面章节」的纵向布局，
          视频按 16:9 一放，一屏只能看到一条章节，两边互相挤。
          改成左右并排后——左栏翻章节、中栏看视频，播放和浏览同时进行。
        */}
        {leftOpen ? (
          <>
            <aside
              // 自动化钩子：右栏也是 <aside>，脚本里按 data-panel 才能只认左栏
              data-panel="left"
              style={{ width: leftWidth }}
              className="bg-white border-r border-gray-200 flex flex-col shrink-0"
            >
              <div className="flex items-center border-b border-gray-200 shrink-0">
                <div className="flex flex-1">
                  {(
                    [
                      ['library', '视频库'],
                      ['chapters', detail ? `章节（${detail.chapters.length}）` : '章节'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setLeftTab(key)}
                      className={[
                        'flex-1 px-3 py-2 text-xs font-medium transition',
                        leftTab === key
                          ? 'text-blue-600 border-b-2 border-blue-600'
                          : 'text-gray-500 hover:text-gray-800',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <IconButton
                  icon={<ChevronsLeftIcon size={15} />}
                  label="折叠左侧栏"
                  onClick={() => setLeftOpen(false)}
                  className="mr-1 border border-gray-200 hover:bg-gray-50 hover:text-gray-700"
                />
              </div>

              {leftTab === 'library' ? (
                <>
                  <ImportPanel
                    pickerAvailable={pickerInfo?.available ?? false}
                    pickerReason={pickerInfo?.reason ?? ''}
                    busy={busy}
                    busyHint={busyHint}
                    onPickFiles={doImportFiles}
                    onPickFolder={doImportFolder}
                    onPastePath={doImport}
                    wide={leftWide}
                  />

                  <FolderList
                    wide={leftWide}
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
                  />
                </>
              ) : (
                <div
                  ref={chapterScrollRef}
                  className="flex-1 min-h-0 overflow-y-auto thin-scroll p-2 space-y-2"
                >
                  {!detail ? (
                    <div className="text-xs text-gray-400 text-center py-8">
                      先在「视频库」里选一个视频
                    </div>
                  ) : (
                    <>
                      {/* 本次分析的模型用量：跟章节放一起，都是「这支视频」的产物 */}
                      {detail.token_usage && detail.token_usage.calls > 0 && (
                        <div className="bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-[10px] text-gray-500 flex items-center gap-1.5 flex-wrap">
                          <span className="tabular-nums">
                            用量{' '}
                            <b className="text-gray-900">
                              {detail.token_usage.total_tokens.toLocaleString('zh-CN')}
                            </b>{' '}
                            tokens
                          </span>
                          <span className="tabular-nums">
                            {detail.token_usage.calls} 次调用
                          </span>
                          <button
                            onClick={() => setShowUsage(true)}
                            className={`ml-auto text-blue-600 hover:underline hover:bg-blue-50 px-1 rounded ${MIN_TAPPABLE}`}
                          >
                            全部 →
                          </button>
                        </div>
                      )}

                      {detail.chapters.length > 0 && (
                        // 摘要必须「按自己那段时间的原文」写。区间被导图同步改过之后，
                        // 旧摘要就对不上了——给它一个一键重写的出口，而不是让用户
                        // 一条条手动改。
                        <div className="flex items-center gap-1.5 px-0.5">
                          <span className="text-[10px] text-gray-400 leading-tight">
                            摘要按各自时间区间生成
                          </span>
                          <button
                            onClick={rewriteSummaries}
                            disabled={rewriting}
                            title={
                              detail.transcript
                                ? '用每章自己区间内的原文重新生成摘要与要点（会覆盖现有内容）'
                                : '这支视频还没有转写结果'
                            }
                            className={`ml-auto shrink-0 text-[10px] px-1.5 rounded border border-gray-200 text-gray-500 hover:bg-white hover:border-gray-300 hover:text-gray-800 disabled:opacity-50 ${MIN_TAPPABLE}`}
                          >
                            {rewriting ? '重写中…' : '按区间重写摘要'}
                          </button>
                        </div>
                      )}

                      {detail.chapters.length > 0 ? (
                        <ChapterList
                          chapters={detail.chapters}
                          currentTime={currentTime}
                          // 章节卡里铺出「这一章包含的导图节点」（节点带摘要，
                          // 但不再内嵌原文——逐字稿在右栏看）
                          mindmap={detail.mindmap}
                          onSeek={(t, end) => seekTo(t, end)}
                          onAdd={addChapter}
                          onPatch={patchChapter}
                          onDelete={removeChapter}
                        />
                      ) : (
                        <div className="text-xs text-gray-400 text-center py-6">
                          {detail.status === 'ready' ? '暂无章节' : '分析完成后自动生成章节'}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </aside>

            <PanelResizer
              label="调整左侧栏宽度"
              onDelta={(dx) => setLeftWidth((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX))}
              onToggle={() => setLeftOpen(false)}
            />
          </>
        ) : (
          <PanelRail
            side="left"
            // 折叠后按 tab 切段：点「视频库」开视频库，点「章节」开章节，
            // 不用「先展开、再点一下标签」两步走
            items={[
              { key: 'library', label: '视频库' },
              { key: 'chapters', label: '章节' },
            ]}
            active={leftTab}
            onPick={(key) => {
              if (key === 'library' || key === 'chapters') setLeftTab(key)
              setLeftOpen(true)
            }}
          />
        )}

        {/*
          中：只剩播放器（+状态卡）。章节搬去了左栏 tab——
          原来「上视频下章节」的纵向布局，两边抢同一块高度：
          视频一大章节就只剩一条缝。并排之后互不打架，
          播放器用整个中栏的高度内接 16:9，画面能给到最大。
        */}
        <main className="flex-1 min-w-0 flex flex-col min-h-0">
          {!detail ? (
            <EmptyState />
          ) : (
            <>
              <PlayerPane
                video={detail}
                playerRef={playerRef}
                seekRequest={seekRequest}
                onTimeUpdate={setCurrentTime}
              />

              {/* 状态卡：独立于播放器高度，不再把画面挤到只剩一条缝 */}
              {(detail.status === 'processing' ||
                detail.status === 'failed' ||
                detail.status === 'pending') && (
                <div className="shrink-0 space-y-1.5 px-3 pb-2">
                  {detail.status === 'processing' && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-blue-900">
                          {STAGE_LABELS[job?.stage ?? ''] ?? '处理中…'}
                        </span>
                        {job?.message && (
                          <span className="min-w-0 flex-1 truncate text-[11px] text-blue-700">
                            {job.message}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[10px] text-blue-600">
                          每 2 秒自动刷新 · 可切到别的视频，后台继续
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 bg-blue-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: '100%' }}
                        />
                      </div>
                    </div>
                  )}

                  {/*
                    失败提示必须能收起。
                    错误原文一长就会把播放区底部整块顶掉——
                    看着像「播放器没了」，其实是红框把高度吃光了。
                    所以给两个出口：× 收成一行，收起后还能点「详情」再看。
                  */}
                  {detail.status === 'failed' && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-red-800">处理失败</span>
                        <button
                          onClick={() => startAnalysis(detail.id, true)}
                          className={`text-[11px] px-2 rounded border border-red-300 text-red-700 hover:bg-red-100 ${MIN_TAPPABLE}`}
                        >
                          重试
                        </button>
                        {!failExpanded && detail.error && (
                          <button
                            onClick={() => setFailExpanded(true)}
                            className="text-[11px] text-red-600 hover:underline"
                          >
                            详情
                          </button>
                        )}
                        <IconButton
                          icon={<CloseIcon size={15} />}
                          label="收起错误详情"
                          onClick={() => setFailExpanded(false)}
                          className="ml-auto text-red-400 hover:text-red-700 hover:bg-red-100"
                        />
                      </div>
                      {failExpanded && detail.error && (
                        <p className="text-[11px] text-red-700 whitespace-pre-wrap mt-1.5 max-h-28 overflow-y-auto thin-scroll">
                          {detail.error}
                        </p>
                      )}
                    </div>
                  )}

                  {detail.status === 'pending' && (
                    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
                      <span className="text-[11px] text-gray-600">尚未分析</span>
                      <button
                        onClick={() => startAnalysis(detail.id)}
                        className={`rounded bg-blue-600 px-3 text-[11px] text-white hover:bg-blue-500 ${MIN_TAPPABLE}`}
                      >
                        开始分析
                      </button>
                    </div>
                  )}
                </div>
              )}
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
              data-panel="right"
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
                    {/* 和标签页同高（24px+），之前是 20×28 的字符 « »，
                        比两边的「思维导图 / 逐字稿」矮一截，看着不齐 */}
                    <IconButton
                      icon={<ChevronsRightIcon size={15} />}
                      label="折叠右侧栏"
                      onClick={() => setRightOpen(false)}
                      // 标签页是 32px 高（py-2），折叠按钮跟着那一行撑满，
                      // 否则它矮 8px，右边像缺了一块
                      className="!h-auto px-1.5 rounded-none hover:bg-gray-50 hover:text-gray-700"
                    />
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
                      <IconButton
                        icon={<CloseIcon size={14} />}
                        label="关闭提示"
                        onClick={() => setFinishNotice(null)}
                        className="hover:text-gray-800 hover:bg-black/5"
                      />
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
          <PanelRail
            side="right"
            // 右栏同理：折叠着也能直接开「思维导图」或「逐字稿」
            items={[
              { key: 'mindmap', label: '思维导图' },
              { key: 'transcript', label: '逐字稿' },
            ]}
            active={rightTab}
            onPick={(key) => {
              if (key === 'mindmap' || key === 'transcript') setRightTab(key)
              setRightOpen(true)
            }}
          />
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
const DEFAULT_LAYOUT = {
  leftWidth: 256,
  rightWidth: 460,
  leftOpen: true,
  rightOpen: true,
}

/**
 * 播放器那一块的上下内边距（pt-3 + pb-2 = 12 + 8）。
 *
 * 播放器窗口要在「可用宽 × 可用高」里内接 16:9，而量到的高度是整块的高度，
 * 内边距得在这里减掉。两处必须同步改，改了 padding 不改这里，窗口又会超出一截。
 */
const PLAYER_CHROME = 20

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

/**
 * 播放区：整个中栏只留播放器。
 *
 * 高度上限在这层组件里量，而不是在 App 里量——包一层组件才能在挂载时拿到
 * ref，App 里那个 ref 在还没选中视频时是空的，effect 那时早就跑完了。
 * 量的是**外框**：外框是 flex-1，高度由父容器定、不随播放器变，
 * 所以不存在「量高度 → 改高度 → 再量」的死循环。
 *
 * 少了这一步真的会出事：把两侧面板折叠掉之后中栏会非常宽，
 * 按满宽算 16:9 得到的高度直接顶出屏幕，画面下半截被裁掉。
 * 而又不能让播放器自己去读容器高度（那才是真的成环），只能由外面喂进去。
 */
function PlayerPane({
  video,
  playerRef,
  seekRequest,
  onTimeUpdate,
}: {
  video: VideoDetail
  playerRef: React.RefObject<HTMLVideoElement>
  seekRequest: SeekRequest | null
  onTimeUpdate: (t: number) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxH, setBoxH] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height
      setBoxH((prev) => (Math.abs(prev - h) < 1 ? prev : h))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div
      ref={boxRef}
      data-player-block="1"
      className="flex min-h-0 flex-1 overflow-hidden px-3 pt-3 pb-2"
    >
      <VideoPlayer
        video={video}
        playerRef={playerRef}
        seekRequest={seekRequest}
        fitHeight={boxH > 0 ? boxH - PLAYER_CHROME : null}
        onTimeUpdate={onTimeUpdate}
      />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        {/* 原先是一个 🎬 emoji：不同系统上渲染成完全不同的图形，
            有的还带颜色，和整站的灰蓝色调打架 */}
        <div className="mb-4 flex justify-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <VideoIcon size={26} />
          </span>
        </div>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">把长视频变成可导航的知识地图</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-4">
          导入本地视频后，自动完成语音转写、智能分章节与思维导图生成。
          点击导图的任意节点或章节卡片，播放器立刻跳到对应的时间点。
        </p>
        <ol className="text-xs text-gray-400 text-left space-y-1.5 bg-gray-50 rounded-lg p-4">
          <li>① 点左侧「选择视频文件导入」，或「选择文件夹批量导入」</li>
          <li>② 导入后可拖到左侧任意分类里，或「新建」一个分类</li>
          <li>③ 进入「设置」配置大模型 API Key（推荐 DeepSeek）</li>
          <li>④ 点击「开始分析」，等待转写与章节生成</li>
          <li>⑤ 在右侧思维导图上点击节点即可跳转播放</li>
        </ol>
      </div>
    </div>
  )
}
