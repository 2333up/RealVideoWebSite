import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VideoDetail } from '../types'
import { api } from '../api'
import { formatTs } from '../lib/format'
import type { SeekRequest } from '../lib/seekRequest'
import {
  ExitFullscreenIcon,
  ForwardIcon,
  FullscreenIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  VolumeIcon,
  VolumeMuteIcon,
} from './icons'

interface Props {
  video: VideoDetail
  playerRef: React.RefObject<HTMLVideoElement>
  seekRequest: SeekRequest | null
  /**
   * 播放器窗口的可用高度上限（px）。
   *
   * 传数字时窗口严格内接进「可用宽 × 可用高」并保持 16:9——
   * 以前是「宽度铺满、高度按 16:9 算」，容器一矮就超出、被裁掉一截，
   * 控制条得滚动才看得到，DOM 上还压在下方的章节卡上面。
   * 传 null 表示由父容器决定（章节区折叠时撑满剩余空间）。
   */
  fitHeight?: number | null
  onTimeUpdate: (t: number) => void
}

/** 控制条自动隐藏的静置时长（毫秒） */
const IDLE_HIDE_MS = 2600

/**
 * 等 metadata 的上限（毫秒）。超了就换成「可以自救」的提示。
 *
 * 大文件的 metadata 要读 MP4 尾部的 moov，正常也就一两秒；
 * 超过这个数基本就是流卡住了（服务器没响应、连接被占满、文件在慢盘上）。
 */
const LOAD_WATCHDOG_MS = 9000

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export default function VideoPlayer({
  video,
  playerRef,
  seekRequest,
  fitHeight = null,
  onTimeUpdate,
}: Props) {
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [curTime, setCurTime] = useState(0)
  const [duration, setDuration] = useState(video.duration || 0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [rateOpen, setRateOpen] = useState(false)
  const [isFull, setIsFull] = useState(false)
  /** 控制条是否可见：播放中鼠标静置一会儿就淡出，把画面整个让出来 */
  const [uiVisible, setUiVisible] = useState(true)
  /**
   * metadata 迟迟不来（流卡住）。
   *
   * 之前这种情况界面上就是一句「加载视频中…」无限挂着：播放按钮不出现、
   * 控制条不出现，用户除了退出这个视频没别的路。现在超时会换成带「重新加载」的提示。
   */
  const [timedOut, setTimedOut] = useState(false)
  /** 换一个带 nonce 的地址重新拉流，丢掉那条可能已经卡死的连接 */
  const [reloadNonce, setReloadNonce] = useState(0)
  // 「播完本章自动暂停」的终点；为 null 表示不启用
  const stopAtRef = useRef<number | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const idleTimer = useRef<number | null>(null)

  useEffect(() => {
    setReady(false)
    setFailed('')
    setCurTime(0)
    setIsPlaying(false)
    setDuration(video.duration || 0)
    setTimedOut(false)
    stopAtRef.current = null
  }, [video.id])

  /**
   * 加载看门狗 + 状态兜底。
   *
   * 两件事：
   *  1. **兜底核对**：`ready` 只靠 onLoadedMetadata 事件置真。万一事件在监听挂上之前
   *     就发过了（元素复用、React 重挂载竞态），界面会永远停在「加载中」。
   *     这里每隔一次渲染核对一下元素的真实 readyState，够了就直接认。
   *  2. **超时**：超过 LOAD_WATCHDOG_MS 还没有 metadata，就标成 timedOut，
   *     把死等换成「重新加载」。卡住的流不会自己好，必须给用户一条出口。
   */
  useEffect(() => {
    const el = playerRef.current
    if (!ready && !failed && el && el.readyState >= 1) {
      setReady(true)
      if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
      return
    }
    if (ready || failed) {
      setTimedOut(false)
      return
    }
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_WATCHDOG_MS)
    return () => window.clearTimeout(timer)
  }, [ready, failed, video.id, reloadNonce, playerRef])

  /** 重新拉流：换一个带 nonce 的地址，避免浏览器复用那条已经卡死的请求 */
  const reloadVideo = () => {
    setTimedOut(false)
    setReady(false)
    setFailed('')
    setReloadNonce((n) => n + 1)
  }

  // ---------------------------------------------------------------- 尺寸

  /**
   * 量可用区域。
   *
   * 只观察宽度与（自适应时的）高度：宽度不受播放器自身影响，不会形成
   * 「改尺寸 -> 触发 observe -> 再改尺寸」的回环；固定高度模式下连高度
   * 都不看（用传进来的 fitHeight），同样是为了断掉回环。
   */
  const [avail, setAvail] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setAvail((prev) =>
        Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: r.width, h: r.height },
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 窗口尺寸：
   *   - 给了高度上限（用户拖过分割线）-> 在「可用宽 × 可用高」里内接一个 16:9，
   *     宽不够时按宽、高不够时按高，两边都不会溢出；
   *   - 没给上限（默认）-> 直接铺满可用宽度，高度按 16:9 算。
   *     这时候**不去读容器高度**：容器的高度正是由窗口撑出来的，
   *     读了就变成「窗口等容器、容器等窗口」的循环。
   */
  const stage = useMemo(() => {
    if (avail.w <= 0) return { w: 0, h: 0 }
    let w = avail.w
    let h = (w * 9) / 16
    if (fitHeight !== null && fitHeight > 0 && h > fitHeight) {
      h = fitHeight
      w = (h * 16) / 9
    }
    return { w: Math.round(w), h: Math.round(h) }
  }, [avail.w, fitHeight])

  // ---------------------------------------------------------------- 控制条显隐

  const clearIdle = () => {
    if (idleTimer.current !== null) {
      window.clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
  }

  const pokeUi = useCallback(() => {
    setUiVisible(true)
    clearIdle()
    idleTimer.current = window.setTimeout(() => setUiVisible(false), IDLE_HIDE_MS)
  }, [])

  // 暂停时控制条必须一直在：暂停就是要去点按钮的，藏起来纯属添乱
  useEffect(() => {
    if (!isPlaying) {
      clearIdle()
      setUiVisible(true)
      return
    }
    pokeUi()
  }, [isPlaying, pokeUi])

  useEffect(() => clearIdle, [])

  // ---------------------------------------------------------------- 播放控制

  const togglePlay = () => {
    const v = playerRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  const skip = (delta: number) => {
    const v = playerRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta))
  }

  /**
   * 键盘：← / → = 后退 / 前进 5 秒（2026-10-18 用户要求）。
   *
   * 三个必须让开的场合：
   *   1. 正在输入框里打字（搜索、改名、时间编辑）——方向键要移光标；
   *   2. 鼠标停在右栏导图上——那边用 ←/→ 做「展开/跳到子节点/回到父节点」，
   *      两处都响应会一边跳播一边挪选中；
   *   3. 事件已经被别人 preventDefault 掉了。
   * 其余情况下，看视频时按方向键理所当然该是快进快退。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const right = document.querySelector('[data-panel="right"]')
      if (right && (right.matches(':hover') || right.contains(document.activeElement))) return
      e.preventDefault()
      skip(e.key === 'ArrowLeft' ? -5 : 5)
      pokeUi()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pokeUi])

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = playerRef.current
    if (!v) return
    const t = Number(e.target.value)
    v.currentTime = t
    setCurTime(t)
    stopAtRef.current = null // 手动拖动后取消自动暂停
  }

  const applyVolume = (value: number) => {
    const v = playerRef.current
    if (v) {
      v.volume = value
      v.muted = value === 0
    }
    setVolume(value)
    setMuted(value === 0)
  }

  const toggleMute = () => {
    const v = playerRef.current
    if (!v) return
    const next = !v.muted
    v.muted = next
    if (!next && v.volume === 0) {
      v.volume = 0.6
      setVolume(0.6)
    }
    setMuted(next)
  }

  const toggleFullscreen = () => {
    const el = stageRef.current
    if (!el) return
    setRateOpen(false)
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void el.requestFullscreen?.().catch(() => {})
    }
  }

  useEffect(() => {
    const onChange = () => setIsFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // ---------------------------------------------------------------- 跳转请求

  /**
   * 响应跳转请求。
   *
   * 两个关键防御：
   *  1. metadata 未就绪时（readyState < 1）不能直接设 currentTime，
   *     否则会被浏览器忽略或抛错——必须等 loadedmetadata。
   *  2. 目标时间必须钳位到 [0, duration]，超出duration 的跳转不会生效。
   */
  useEffect(() => {
    if (!seekRequest) return
    const videoEl = playerRef.current
    if (!videoEl) return

    const { seconds, endSeconds } = seekRequest
    if (!Number.isFinite(seconds)) return

    stopAtRef.current = Number.isFinite(endSeconds as number) ? (endSeconds as number) : null

    const seekTo = () => {
      const el = playerRef.current
      if (!el) return
      const dur = Number.isFinite(el.duration) ? el.duration : null
      const target =
        dur == null ? Math.max(0, seconds) : Math.min(Math.max(0, seconds), dur)
      el.currentTime = target
      setCurTime(target)
      // 点击属于用户手势，自动播放不会被策略拦截；仍 catch 以免打断后续逻辑
      el.play().catch(() => {})
    }

    if (videoEl.readyState >= 1) {
      seekTo()
      return
    }
    videoEl.addEventListener('loadedmetadata', seekTo, { once: true })
    return () => videoEl.removeEventListener('loadedmetadata', seekTo)
  }, [seekRequest, playerRef])

  const handleTimeUpdate = (t: number) => {
    setCurTime(t)
    onTimeUpdate(t)
    // 到达章节终点自动暂停：让「播放本章」成为一个完整动作
    const stop = stopAtRef.current
    if (stop !== null && t >= stop) {
      playerRef.current?.pause()
      stopAtRef.current = null
    }
  }

  const played = duration > 0 ? (curTime / duration) * 100 : 0

  return (
    // 黑底圆角：用户把播放器区拖小时窗口会窄于可用宽度，两侧的余量做成黑边
    // （播放器里的信箱边本来就是黑的），比留一块浅色空白顺眼得多
    <div
      ref={wrapRef}
      className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-lg bg-black"
    >
      <div
        ref={stageRef}
        data-player-stage="1"
        // 全屏时铺满：固定 px 尺寸会让全屏里只剩一小块画面
        style={isFull ? { width: '100%', height: '100%' } : { width: stage.w, height: stage.h }}
        className={[
          'relative overflow-hidden bg-black',
          isFull ? '' : 'rounded-lg',
          uiVisible ? '' : 'cursor-none',
        ].join(' ')}
        onMouseMove={pokeUi}
        // 点画面 = 播放/暂停（2026-10-18 用户要求）。
        // 之前只有暂停时中央那个大播放按钮能点，播放中点画面毫无反应——
        // 几乎所有人都习惯「点一下暂停」，这不是可选项。
        // 控制条自己是另一个热区，它在内部 stopPropagation，不会连带切换。
        onClick={() => {
          if (ready && !failed) togglePlay()
        }}
        onMouseLeave={() => {
          if (isPlaying) setUiVisible(false)
        }}
      >
        {/* src 后面的 nonce 只会在点过「重新加载」之后出现：
            换地址才能让浏览器丢掉那条可能已经卡死的连接，重新拉一条流 */}
        <video
          ref={playerRef}
          className="h-full w-full bg-black object-contain"
          src={api.streamUrl(video.id) + (reloadNonce ? `?r=${reloadNonce}` : '')}
          preload="metadata"
          playsInline
          onLoadedMetadata={(e) => {
            setReady(true)
            setDuration(e.currentTarget.duration || video.duration || 0)
          }}
          onError={() =>
            setFailed('视频加载失败。原始文件可能已被移动或删除，请重新导入该视频。')
          }
          onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget.currentTime)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onVolumeChange={(e) => {
            setVolume(e.currentTarget.volume)
            setMuted(e.currentTarget.muted)
          }}
        />

        {!ready && !failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            {timedOut ? (
              <>
                <span className="text-xs font-medium text-amber-300">视频加载超时</span>
                <span className="text-[10px] leading-relaxed text-gray-400">
                  流卡住了（大文件要先读文件尾部的索引），
                  <br />
                  重新拉一次通常就能恢复。
                </span>
                <button
                  type="button"
                  onClick={reloadVideo}
                  // 深色底上的按钮：用描边 + 悬停提亮，跟控制条一个语汇
                  className="mt-1 min-h-[24px] rounded border border-gray-500 px-2.5 text-[11px] text-gray-100 transition-colors hover:border-gray-300 hover:bg-white/10"
                >
                  重新加载
                </button>
              </>
            ) : (
              <span className="text-xs text-gray-400">加载视频中…</span>
            )}
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-red-300 text-xs">
            {failed}
          </div>
        )}

        {/* 中央播放按钮：只在暂停时露面，把画面让出来 */}
        {ready && !failed && !isPlaying && (
          <button
            type="button"
            onClick={(e) => {
              // 别让这次点击冒泡到画面：画面那层的 onClick 也会切换播放，
              // 两层都响应等于「点了没反应」
              e.stopPropagation()
              togglePlay()
            }}
            aria-label="播放"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-transparent"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 text-white shadow-lg backdrop-blur-sm transition-transform hover:scale-105">
              <PlayIcon size={24} />
            </span>
          </button>
        )}

        {/*
          控制条悬浮在画面上（不再单独占一行）。
          以前它在视频下面常驻 64px，加上视频按满宽 16:9 排，两个高度一叠
          就超出容器——现在这部分高度彻底省掉了。
        */}
        {ready && !failed && (
          <div
            className={[
              'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent pt-6 transition-opacity duration-200',
              uiVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
            ].join(' ')}
            onMouseMove={pokeUi}
            // 控制条是独立热区：点进度条、音量、倍速都不该把视频暂停
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2.5">
              <input
                type="range"
                min={0}
                max={duration || video.duration || 0}
                step={0.1}
                value={curTime}
                onChange={onScrub}
                className="vm-seek w-full"
                style={{ ['--played' as string]: `${played}%` }}
                aria-label="播放进度"
              />
            </div>

            <div className="flex items-center gap-0.5 px-1.5 pb-1">
              <Ctl onClick={togglePlay} title={isPlaying ? '暂停' : '播放'}>
                {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
              </Ctl>
              {/* 档位写全「10 秒 / 5 秒」：只写数字时，图标本身也带语义（后退/前进），
                  两三个字符并排容易被读成「先后退 10 次」这种歧义 */}
              <Ctl onClick={() => skip(-10)} title="后退 10 秒">
                <RewindIcon size={17} />
                <span className="text-[10px] tabular-nums whitespace-nowrap">10 秒</span>
              </Ctl>
              <Ctl onClick={() => skip(-5)} title="后退 5 秒">
                <RewindIcon size={17} />
                <span className="text-[10px] tabular-nums whitespace-nowrap">5 秒</span>
              </Ctl>
              <Ctl onClick={() => skip(5)} title="前进 5 秒">
                <span className="text-[10px] tabular-nums whitespace-nowrap">5 秒</span>
                <ForwardIcon size={17} />
              </Ctl>
              <Ctl onClick={() => skip(10)} title="前进 10 秒">
                <span className="text-[10px] tabular-nums whitespace-nowrap">10 秒</span>
                <ForwardIcon size={17} />
              </Ctl>

              <span className="px-1.5 text-[11px] tabular-nums text-white/80">
                {formatTs(curTime)} / {formatTs(duration)}
              </span>

              {stopAtRef.current !== null && (
                <span className="hidden text-[10px] text-amber-300 sm:inline">
                  本章结束自动暂停
                </span>
              )}

              <div className="ml-auto flex items-center gap-0.5">
                <Ctl onClick={toggleMute} title={muted ? '取消静音' : '静音'}>
                  {muted || volume === 0 ? (
                    <VolumeMuteIcon size={18} />
                  ) : (
                    <VolumeIcon size={18} />
                  )}
                </Ctl>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => applyVolume(Number(e.target.value))}
                  className="vm-vol hidden w-14 sm:block"
                  style={{ ['--played' as string]: `${(muted ? 0 : volume) * 100}%` }}
                  aria-label="音量"
                />

                {/* 倍速：点一下弹出档位，和主流播放器一致的收纳方式 */}
                <div className="relative">
                  <Ctl
                    onClick={() => setRateOpen((v) => !v)}
                    title="播放倍速"
                    className="min-w-[38px] text-[11px] tabular-nums"
                  >
                    {rate}x
                  </Ctl>
                  {rateOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onMouseDown={() => setRateOpen(false)}
                      />
                      <div className="absolute bottom-full right-0 z-20 mb-1 rounded-md border border-white/15 bg-black/90 py-1 backdrop-blur">
                        {RATES.map((r) => (
                          <button
                            key={r}
                            type="button"
                            onClick={() => {
                              const v = playerRef.current
                              if (v) v.playbackRate = r
                              setRate(r)
                              setRateOpen(false)
                            }}
                            className={[
                              'block w-full px-3 py-1 text-left text-[11px] tabular-nums transition',
                              r === rate
                                ? 'text-white'
                                : 'text-white/70 hover:bg-white/15 hover:text-white',
                            ].join(' ')}
                          >
                            {r}x
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <Ctl onClick={toggleFullscreen} title={isFull ? '退出全屏' : '全屏'}>
                  {isFull ? <ExitFullscreenIcon size={18} /> : <FullscreenIcon size={18} />}
                </Ctl>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 控制条上的按钮：统一 32px 高，图标 17-18px，与主流播放器一个量级 */
function Ctl({
  children,
  onClick,
  title,
  className = '',
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={[
        'inline-flex h-8 min-w-[32px] shrink-0 items-center justify-center gap-0.5 rounded px-1.5',
        'text-white/90 transition hover:bg-white/20 hover:text-white',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}
