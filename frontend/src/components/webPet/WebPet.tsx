import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import manifest from './manifest.json'

/**
 * 网页版桌宠（鲸汐）。
 *
 * 与桌面版（pet/ 里的 PyQt6 程序）共用同一套帧素材、台词与姿态映射，
 * 但这里是浏览器里重新实现的：桌面版能做的「透明置顶盖住其他软件」浏览器做不到，
 * 页面内的悬浮、走动、互动则可以完整复刻。
 *
 * 几个实现取舍：
 * - **位移动画不走 React state**：走动是 ~30fps 的连续变化，用 state 会让整棵组件
 *   每帧重渲染。这里用 ref 持有位置，rAF 里直接改 style.transform。
 * - **帧图用 import.meta.glob 预取 URL**：Vite 会给每张图加 hash，配合 <link rel=preload>
 *   一样的浏览器缓存；切帧只是换 src，不会闪。
 * - **命中区域是矩形**：图片四角透明但仍会吞点击。桌面版同理，属于可接受范围；
 *   容器整体 pointer-events-none，只有角色本身可交互，不会挡住页面其他操作。
 */

type PoseKey = 'idle' | 'drag' | 'double' | 'poke' | 'pat'
type Lines = Record<string, string[]>

const M = manifest as unknown as {
  canvas: { w: number; h: number }
  frames: string[]
  font: string
  bubbleAnchor: number
  poses: Record<PoseKey, number>
  walk: { frames: number[]; speed: number; pause: number[]; duration: number[]; fps: number }
  lines: Lines
}

// 帧图 URL：Vite 处理过的最终地址（带 hash）
const FRAME_URLS = import.meta.glob('../../assets/pet/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>
const PEEK_URLS = import.meta.glob('../../assets/pet/peek.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>
const PEEK_URL = Object.values(PEEK_URLS)[0] ?? ''

const FONT_URLS = import.meta.glob('../../assets/pet/*.ttf', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const frameUrl = (name: string) =>
  FRAME_URLS[`../../assets/pet/${name}`] ?? FRAME_URLS[`../../assets/pet/f000.webp`]

const FONT_URL = Object.values(FONT_URLS)[0] ?? ''
const FONT_FAMILY = 'PetBubbleWeb'

/** 尺寸策略：大屏 200px，中屏 170，小屏 140，再小就不显示（避免挡住移动端内容） */
function pickSize(): number {
  if (typeof window === 'undefined') return 200
  const w = window.innerWidth
  if (w >= 1280) return 200
  if (w >= 900) return 170
  if (w >= 640) return 140
  return 0
}

const POS_KEY = 'lingoseek.pet.pos'
const HOLD_MS = 700
const SLOP = 4

export default function WebPet() {
  const [size, setSize] = useState(pickSize)
  const [frame, setFrame] = useState(M.poses.idle ?? 0)
  const [dir, setDir] = useState(1)
  const [bubble, setBubble] = useState<string | null>(null)
  // 贴边状态：拖到视口左右边缘松开后吸附，只露头
  const [dock, setDock] = useState<'left' | 'right' | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const posRef = useRef({ x: -1, y: 8 }) // x=-1 表示尚未初始化
  const walkRef = useRef({
    walking: false,
    until: 0,
    next: 0,
    dir: 1,
    frameAt: 0,
    idx: 0,
  })
  const dragRef = useRef({
    active: false,
    moved: false,
    sx: 0,
    sy: 0,
    ox: 0,
    oy: 0,
    pressAt: 0,
    handled: false,
  })
  const hoverRef = useRef(false)
  const longRef = useRef<number | null>(null)
  const bubbleTimer = useRef<number | null>(null)

  const W = Math.round((size * M.canvas.w) / M.canvas.h)
  const H = size

  // ---------------------------------------------------------------- 字体
  useEffect(() => {
    if (!FONT_URL || document.getElementById('pet-bubble-font')) return
    const style = document.createElement('style')
    style.id = 'pet-bubble-font'
    style.textContent = `@font-face{font-family:'${FONT_FAMILY}';src:url('${FONT_URL}') format('truetype');font-display:swap;}`
    document.head.appendChild(style)
  }, [])

  // ---------------------------------------------------------------- 预加载
  useEffect(() => {
    M.frames.forEach((n) => {
      const im = new Image()
      im.src = frameUrl(n)
    })
  }, [])

  // ---------------------------------------------------------------- 位置
  const applyPos = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const { x, y } = posRef.current
    el.style.transform = `translate3d(${x}px, ${window.innerHeight - H - y}px, 0)`
  }, [H])

  const clampX = useCallback(
    (x: number) => {
      const max = Math.max(8, window.innerWidth - W - 8)
      return Math.min(Math.max(8, x), max)
    },
    [W],
  )

  useEffect(() => {
    // 尺寸变化时重新计算位置并夹回可视区
    const saved = (() => {
      try {
        const raw = localStorage.getItem(POS_KEY)
        return raw ? (JSON.parse(raw) as { x: number; y: number }) : null
      } catch {
        return null
      }
    })()
    if (size === 0) return
    posRef.current = {
      x: clampX(saved?.x ?? window.innerWidth - W - 24),
      y: Math.max(8, saved?.y ?? 8),
    }
    applyPos()
  }, [size, W, clampX, applyPos])

  useEffect(() => {
    const onResize = () => {
      const s = pickSize()
      setSize(s)
      if (s === 0) return
      posRef.current.x = clampX(posRef.current.x)
      applyPos()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampX, applyPos])

  // ---------------------------------------------------------------- 说话
  const say = useCallback((key: string) => {
    const pool = M.lines[key] ?? M.lines.idle ?? []
    if (!pool.length) return
    setBubble(pool[Math.floor(Math.random() * pool.length)])
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(null), 2800)
  }, [])

  const showPose = useCallback((key: PoseKey) => {
    setFrame(M.poses[key] ?? 0)
  }, [])

  // ---------------------------------------------------------------- 主循环
  useEffect(() => {
    if (size === 0) return
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = performance.now()

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const st = walkRef.current
      const busy = dragRef.current.active || hoverRef.current || bubble !== null || dock !== null

      if (reduce || busy) {
        if (st.walking) {
          st.walking = false
          st.next = now + 4000
          setDir(1)
          showPose('idle')
        }
      } else if (!st.walking) {
        if (!st.next) st.next = now + 4000 + Math.random() * 4000
        if (now >= st.next) {
          st.walking = true
          st.dir = Math.random() < 0.5 ? -1 : 1
          const d = M.walk.duration ?? [2.5, 6]
          st.until = now + (d[0] + Math.random() * (d[1] - d[0])) * 1000
          st.idx = 0
          st.frameAt = now
          setDir(st.dir)
          setFrame(M.walk.frames[0])
        }
      } else {
        // 走动中：位移 + 换帧
        const step = (M.walk.speed ?? 46) * dt * st.dir
        let nx = posRef.current.x + step
        if (nx <= 8 || nx >= window.innerWidth - W - 8) {
          st.dir *= -1
          setDir(st.dir)
          nx = Math.min(Math.max(8, nx), Math.max(8, window.innerWidth - W - 8))
        }
        posRef.current.x = nx
        applyPos()

        const interval = 1000 / (M.walk.fps ?? 7.5)
        if (now - st.frameAt >= interval) {
          st.frameAt = now
          st.idx = (st.idx + 1) % M.walk.frames.length
          setFrame(M.walk.frames[st.idx])
        }
        if (now >= st.until) {
          st.walking = false
          const p = M.walk.pause ?? [6, 14]
          st.next = now + (p[0] + Math.random() * (p[1] - p[0])) * 1000
          setDir(1)
          showPose('idle')
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(posRef.current))
          } catch {
            /* 隐私模式忽略 */
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [size, bubble, dock, W, applyPos, showPose])

  // ---------------------------------------------------------------- 贴边
  /** 松开时若贴着视口左右边缘，就吸附成「只露头」的形态 */
  const tryDock = useCallback(() => {
    if (!PEEK_URL) return false
    const EDGE = 28
    const x = posRef.current.x
    if (x <= EDGE) {
      setBubble(null)
      setDock('left')
      return true
    }
    if (x >= window.innerWidth - W - EDGE) {
      setBubble(null)
      setDock('right')
      return true
    }
    return false
  }, [W])

  /** 点一下探出来的头：钻回页面里 */
  const undock = useCallback(() => {
    if (!dock) return
    const inward = 56
    posRef.current.x =
      dock === 'left'
        ? Math.min(window.innerWidth - W - 8, inward)
        : Math.max(8, window.innerWidth - W - inward)
    setDock(null)
    setFrame(M.poses.idle ?? 0)
    setDir(1)
    say('talk')
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(posRef.current))
    } catch {
      /* ignore */
    }
  }, [dock, W, say])

  // 出边后把窗口摆回新位置（贴边期间 wrapper 不渲染，transform 需要重算）
  useEffect(() => {
    if (!dock) applyPos()
  }, [dock, applyPos])

  // ---------------------------------------------------------------- 交互
  const onPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    if (e.button !== 0) return
    const st = dragRef.current
    st.active = true
    st.moved = false
    st.handled = false
    st.sx = e.clientX
    st.sy = e.clientY
    st.ox = posRef.current.x
    st.oy = posRef.current.y
    st.pressAt = performance.now()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    if (walkRef.current.walking) {
      walkRef.current.walking = false
      walkRef.current.next = performance.now() + 5000
    }
    longRef.current = window.setTimeout(() => {
      if (dragRef.current.active && !dragRef.current.moved) {
        dragRef.current.handled = true
        showPose('pat')
        say('pat')
      }
    }, HOLD_MS)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLImageElement>) => {
    const st = dragRef.current
    if (!st.active) return
    const dx = e.clientX - st.sx
    const dy = e.clientY - st.sy
    if (!st.moved && Math.hypot(dx, dy) > SLOP) {
      st.moved = true
      if (longRef.current) window.clearTimeout(longRef.current)
      showPose('drag')
    }
    if (st.moved) {
      posRef.current.x = clampX(st.ox + dx)
      posRef.current.y = Math.max(0, st.oy - dy)
      applyPos()
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLImageElement>) => {
    const st = dragRef.current
    if (!st.active) return
    st.active = false
    if (longRef.current) window.clearTimeout(longRef.current)
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (st.moved) {
      if (tryDock()) return
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(posRef.current))
      } catch {
        /* ignore */
      }
      showPose('idle')
      return
    }
    if (!st.handled && performance.now() - st.pressAt < HOLD_MS) {
      showPose('poke')
      say('poke')
    }
  }

  const onDoubleClick = () => {
    showPose('double')
    say('double')
  }

  if (size === 0) return null

  // 贴边形态：只露头。素材的裁切边正好贴住视口边缘，看起来像从屏幕外探头。
  // 右侧用水平镜像复用同一张图（素材只有朝右的一个朝向）。
  if (dock) {
    return (
      <img
        src={PEEK_URL}
        alt=""
        draggable={false}
        onClick={undock}
        onDragStart={(e) => e.preventDefault()}
        title="点一下让我出来"
        className="fixed bottom-0 z-40 cursor-pointer select-none"
        style={{
          height: Math.round(size * 0.95),
          left: dock === 'left' ? 0 : 'auto',
          right: dock === 'right' ? 0 : 'auto',
          transform: dock === 'right' ? 'scaleX(-1)' : undefined,
          filter: 'drop-shadow(0 2px 6px rgba(30, 45, 80, 0.22))',
        }}
      />
    )
  }

  return (
    <>
      <div
        ref={wrapRef}
        className="pointer-events-none fixed left-0 top-0 z-40 select-none"
        style={{ width: W, height: H }}
        aria-hidden="true"
      >
        <img
          src={frameUrl(M.frames[frame] ?? M.frames[0])}
          alt=""
          draggable={false}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerEnter={() => {
            hoverRef.current = true
          }}
          onPointerLeave={() => {
            hoverRef.current = false
          }}
          onDoubleClick={onDoubleClick}
          onDragStart={(e) => e.preventDefault()}
          className="pointer-events-auto h-full w-full cursor-grab active:cursor-grabbing"
          style={{
            transform: `scaleX(${dir})`,
            transition: 'transform 120ms linear',
            filter: 'drop-shadow(0 3px 6px rgba(30, 45, 80, 0.18))',
          }}
        />

        {bubble ? (
          <div
            className="pointer-events-none absolute bottom-full mb-1.5 whitespace-nowrap rounded-[14px]
                       border bg-white/95 px-3 py-1.5 text-[13px] leading-snug text-[#4a5568] shadow-sm
                       animate-[petBubbleIn_140ms_ease-out]"
            style={{
              // 用清单里的内容锚点而不是 50%：某些姿势（手臂张开）内容重心会偏
              left: `${(M.bubbleAnchor || 0.5) * 100}%`,
              transform: 'translateX(-50%)',
              borderColor: '#acc8ea',
              fontFamily: FONT_URL ? `'${FONT_FAMILY}', 'Microsoft YaHei', sans-serif` : 'inherit',
              letterSpacing: '0.3px',
            }}
          >
            {bubble}
            <span
              className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45
                         border-b border-r bg-white/95"
              style={{ borderColor: '#acc8ea' }}
            />
          </div>
        ) : null}
      </div>

      {/* 气泡淡入动画：Tailwind 没有内置，用一次性的 keyframes */}
      <style>{`@keyframes petBubbleIn{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}`}</style>
    </>
  )
}
