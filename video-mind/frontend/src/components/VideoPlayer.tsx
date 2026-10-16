import { useEffect, useRef, useState } from 'react'
import type { VideoDetail } from '../types'
import { api } from '../api'
import { formatTs } from '../lib/format'
import type { SeekRequest } from '../lib/seekRequest'

interface Props {
  video: VideoDetail
  playerRef: React.RefObject<HTMLVideoElement>
  seekRequest: SeekRequest | null
  onTimeUpdate: (t: number) => void
}

export default function VideoPlayer({ video, playerRef, seekRequest, onTimeUpdate }: Props) {
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [curTime, setCurTime] = useState(0)
  const [duration, setDuration] = useState(video.duration || 0)
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  // 「播完本章自动暂停」的终点；为 null 表示不启用
  const stopAtRef = useRef<number | null>(null)

  useEffect(() => {
    setReady(false)
    setFailed('')
    setCurTime(0)
    setIsPlaying(false)
    setDuration(video.duration || 0)
    stopAtRef.current = null
  }, [video.id])

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

  const togglePlay = () => {
    const v = playerRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = playerRef.current
    if (!v) return
    const t = Number(e.target.value)
    v.currentTime = t
    setCurTime(t)
    stopAtRef.current = null // 手动拖动后取消自动暂停
  }

  const skip = (delta: number) => {
    const v = playerRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta))
  }

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

  return (
    <div className="flex flex-col bg-black rounded-lg overflow-hidden">
      <div className="relative bg-black" style={{ minHeight: 220 }}>
        <video
          ref={playerRef}
          className="w-full max-h-[46vh] bg-black"
          src={api.streamUrl(video.id)}
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
          onVolumeChange={(e) => setVolume(e.currentTarget.volume)}
        />

        {!ready && !failed && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">
            加载视频中…
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-red-300 text-sm">
            {failed}
          </div>
        )}

        {/* 中央点击层：点击视频画面任意位置（含正中）即可切换播放/暂停。
            仅在视频就绪且未失败时显示，避免遮挡「加载中 / 失败」提示。 */}
        {ready && !failed && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? '暂停' : '播放'}
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-transparent"
          >
            {!isPlaying && (
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-3xl text-white shadow-lg transition-transform hover:scale-105">
                ▶
              </span>
            )}
          </button>
        )}
      </div>

      <div className="bg-gray-900 text-gray-200 px-3 py-2 space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums w-12 text-right">{formatTs(curTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || video.duration || 0}
            step={0.1}
            value={curTime}
            onChange={onScrub}
            className="flex-1 accent-blue-500 h-1 cursor-pointer"
            aria-label="播放进度"
          />
          <span className="text-xs tabular-nums w-12">{formatTs(duration)}</span>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => skip(-10)}
            className="px-2 py-1 rounded hover:bg-gray-700 transition"
            title="后退 10 秒"
          >
            « 10s
          </button>
          <button
            onClick={togglePlay}
            className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 font-medium transition"
          >
            {isPlaying ? '暂停' : '播放'}
          </button>
          <button
            onClick={() => skip(10)}
            className="px-2 py-1 rounded hover:bg-gray-700 transition"
            title="前进 10 秒"
          >
            10s »
          </button>
          {stopAtRef.current !== null && (
            <span className="text-[10px] text-amber-300">本章结束自动暂停</span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1">
              <span>音量</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (playerRef.current) playerRef.current.volume = v
                  setVolume(v)
                }}
                className="w-16 accent-blue-500"
                aria-label="音量"
              />
            </label>
            <label className="flex items-center gap-1">
              <span>倍速</span>
              <select
                value={rate}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (playerRef.current) playerRef.current.playbackRate = v
                  setRate(v)
                }}
                className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs"
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}x
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
