interface Props {
  /** left = 贴在屏幕最左侧（展开箭头朝右）；right = 最右侧 */
  side: 'left' | 'right'
  label: string
  onExpand: () => void
}

/**
 * 侧栏折叠后留下的窄条。
 *
 * 完全收成 0 宽度会让用户「找不回入口」——尤其新用户会以为功能没了。
 * 留一条 36px 的竖条，既几乎不占地方，又永远能点回来。
 */
export default function PanelRail({ side, label, onExpand }: Props) {
  return (
    <div
      className={[
        'w-9 shrink-0 bg-white flex flex-col items-center py-2 gap-2',
        side === 'left' ? 'border-r border-gray-200' : 'border-l border-gray-200',
      ].join(' ')}
    >
      <button
        onClick={onExpand}
        title={`展开${label}`}
        className="w-6 h-6 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-800 flex items-center justify-center text-[11px] leading-none"
      >
        {side === 'left' ? '»' : '«'}
      </button>
      <span
        className="text-[10px] text-gray-400 tracking-widest"
        style={{ writingMode: 'vertical-rl' }}
        title={`点击上方按钮展开${label}`}
      >
        {label}
      </span>
    </div>
  )
}
