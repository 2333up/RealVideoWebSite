import { ChevronsLeftIcon, ChevronsRightIcon } from './icons'

interface RailItem {
  key: string
  label: string
}

interface Props {
  /** left = 贴在屏幕最左侧（展开箭头朝右）；right = 最右侧 */
  side: 'left' | 'right'
  /** 侧栏里有哪些 tab。折叠后一段一个，点哪段就展开到哪个 tab */
  items: RailItem[]
  /** 当前所在 tab：高亮它，展开箭头也只在它里面出现 */
  active: string
  onPick: (key: string) => void
}

/**
 * 侧栏折叠后留下的窄条，做成**竖排 tab**。
 *
 * 以前是一条光板：上面一个独立的展开箭头，下面一行竖排文字。
 * 左侧栏有了「视频库 / 章节」两个 tab 之后这就说不通了——
 * 窄条只能显示一个标签，想进另一个还得先展开再点一下，等于两次操作。
 *
 * 现在按 tab 切成几段：点哪一段就展开到哪个 tab。
 * 展开箭头缩在**当前那一段**里，和标签是同一次点击，不再是单独的按钮——
 * 这正是「展开按钮与视频库/章节融为一体」的字面实现。
 *
 * 注意 aria-label 仍是「展开<标签>」：脚本靠它找窄条，
 * 语义上也确实是「展开并切到这个 tab」。
 */
export default function PanelRail({ side, items, active, onPick }: Props) {
  const chevron =
    side === 'left' ? <ChevronsRightIcon size={14} /> : <ChevronsLeftIcon size={14} />

  return (
    <div
      className={[
        'w-9 shrink-0 bg-white flex flex-col',
        side === 'left' ? 'border-r border-gray-200' : 'border-l border-gray-200',
      ].join(' ')}
    >
      {items.map((it) => {
        const on = it.key === active
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onPick(it.key)}
            aria-label={`展开${it.label}`}
            title={`展开${side === 'left' ? '左侧栏' : '右侧栏'}并切到「${it.label}」`}
            className={[
              // min-h 定住段高：竖排文字的字数不同（视频库 3 字 / 章节 2 字），
              // 不定高的话两段一高一矮，看着像没对齐
              'group flex w-full min-h-[60px] flex-col items-center justify-center gap-1 py-1.5 transition-colors border-b border-gray-100',
              // 当前 tab 那一段：一条蓝线 + 淡蓝底，和展开后的标签页同一个语言
              on
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800',
              side === 'left'
                ? on
                  ? 'border-l-2 border-l-blue-600'
                  : 'border-l-2 border-l-transparent'
                : on
                  ? 'border-r-2 border-r-blue-600'
                  : 'border-r-2 border-r-transparent',
            ].join(' ')}
          >
            <span className={on ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'}>
              {chevron}
            </span>
            <span className="text-[10px] tracking-widest" style={{ writingMode: 'vertical-rl' }}>
              {it.label}
            </span>
          </button>
        )
      })}
      {/* 底部留白：让窄条和侧栏同高，而不是缩在左上角一小块 */}
      <div className="flex-1" />
    </div>
  )
}
