import { useRef, useState } from 'react'

interface Props {
  /** 传入本次鼠标位移的增量（px），由父组件负责夹取与落盘 */
  onDelta: (dx: number) => void
  /** 双击折叠/展开：拖累了就想一键收起来 */
  onToggle?: () => void
  label: string
}

/**
 * 拖拽调宽/调高把手。
 *
 * 为什么自己写而不用 react-resizable-panels：这里只需要「拖动一条线改尺寸」，
 * 30 行 pointer 事件就能搞定，且不会引入一套带自己状态管理范式的库。
 *
 * 用 pointer 事件而不是 mouse 事件：触屏与手写笔一样能用，
 * 且 setPointerCapture 能保证鼠标移出把手后依然收得到 move/up——
 * 少了这一步，拖快一点就会「把手跟丢鼠标」，尺寸卡在半路。
 */
export default function PanelResizer({ onDelta, onToggle, label }: Props) {
  const [dragging, setDragging] = useState(false)
  /**
   * 拖拽中的判定用 ref 而不是 state。
   *
   * state 要等 React 重渲染后才在闭包里生效，而 pointermove 可能在那之前就到了
   * —— 那样第一批位移会被 `if (!dragging) return` 直接丢掉，
   * 表现就是「拖了一大段，尺寸只动了一点点」。ref 是同步的，不依赖渲染时机。
   * state 只留着给拖动中的高亮样式用。
   */
  const active = useRef(false)
  const last = useRef(0)

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = e.clientX
    active.current = true
    setDragging(true)
    // 拖动时禁止选中文字：否则鼠标一快就选满整页
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    active.current = false
    setDragging(false)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active.current) return
    const pos = e.clientX
    const d = pos - last.current
    if (d === 0) return
    last.current = pos
    onDelta(d)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="拖动调整宽度 · 双击折叠/展开"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onToggle}
      className={[
        'shrink-0 w-1.5 cursor-col-resize transition-colors select-none touch-none',
        dragging ? 'bg-blue-400' : 'bg-transparent hover:bg-blue-300',
      ].join(' ')}
    />
  )
}
