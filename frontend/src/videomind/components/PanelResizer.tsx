import { useRef, useState } from 'react'

interface Props {
  /** 传入本次鼠标位移的增量（px），由父组件负责夹取与落盘 */
  onDelta: (dx: number) => void
  /** 双击折叠/展开：拖累了就想一键收起来 */
  onToggle?: () => void
  label: string
}

/**
 * 侧栏拖拽调宽把手。
 *
 * 为什么自己写而不用 react-resizable-panels：这里只需要「拖动一条竖线改宽度」，
 * 30 行 pointer 事件就能搞定，且不会引入一套带自己状态管理范式的库。
 *
 * 用 pointer 事件而不是 mouse 事件：触屏与手写笔一样能用，
 * 且 setPointerCapture 能保证鼠标移出把手后依然收得到 move/up——
 * 少了这一步，拖快一点就会「把手跟丢鼠标」，宽度卡在半路。
 */
export default function PanelResizer({ onDelta, onToggle, label }: Props) {
  const [dragging, setDragging] = useState(false)
  const lastX = useRef(0)

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    lastX.current = e.clientX
    setDragging(true)
    // 拖动时禁止选中文字：否则鼠标一快就选满整页
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setDragging(false)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="拖动调整宽度 · 双击折叠/展开"
      onPointerDown={begin}
      onPointerMove={(e) => {
        if (!dragging) return
        const dx = e.clientX - lastX.current
        if (dx === 0) return
        lastX.current = e.clientX
        onDelta(dx)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onToggle}
      className={[
        'w-1.5 shrink-0 cursor-col-resize transition-colors select-none touch-none',
        dragging ? 'bg-blue-400' : 'bg-transparent hover:bg-blue-300',
      ].join(' ')}
    />
  )
}
