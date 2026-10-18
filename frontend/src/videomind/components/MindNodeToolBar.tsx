import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  MIN_TAPPABLE,
  NoteIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from './icons'

/**
 * 固定在顶部的节点操作条。
 *
 * 它取代了之前钉在节点下方的悬浮工具条。悬浮方案有三个绕不过去的毛病：
 *   - 位置跟着节点走，密集导图里必然被下方/相邻节点盖住；
 *   - 为了不遮正文只能做得极小，按钮挤成一团；
 *   - 鼠标要先悬停到节点上才出现，够到它的路径还容易误触别的节点。
 * 固定在顶部后位置恒定、不参与画布缩放，按钮可以做得大而有间距，
 * 并且一眼就能看出「当前操作的是哪个节点」。
 *
 * 作用对象是「当前选中的节点」，只读模式下整条置灰——
 * 只读模式的价值就在于让人放心点，不必担心误改。
 */
export interface ToolBarNodeInfo {
  id: string
  label: string
  color: string
  hasChildren: boolean
  /** 有非笔记子节点 = 时间范围由子节点算出来，不可手填 */
  timedChildren: boolean
  collapsed: boolean
  /** 笔记节点：不挂时间轴，「时间」按钮永久禁用 */
  note: boolean
}

interface Props {
  node: ToolBarNodeInfo | null
  editable: boolean
  onRename: () => void
  onAddChild: () => void
  onAddSibling: () => void
  onAddNote: () => void
  onEditTime: () => void
  onToggleCollapse: () => void
  onRemove: () => void
}

export default function MindNodeToolBar({
  node,
  editable,
  onRename,
  onAddChild,
  onAddSibling,
  onAddNote,
  onEditTime,
  onToggleCollapse,
  onRemove,
}: Props) {
  const usable = editable && !!node

  return (
    // flex-wrap：面板被拖窄时按钮换行，而不是被裁掉半截
    <div className="shrink-0 flex items-center flex-wrap gap-x-1 gap-y-1 px-2 py-1 border-b border-gray-100 bg-gray-50/70">
      {/* 当前作用对象。没有选中节点时整条按钮都是灰的，这里就是唯一的原因说明 */}
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <span
          className="shrink-0 rounded-full"
          style={{
            width: 8,
            height: 8,
            background: node ? node.color : '#cbd5e1',
          }}
        />
        <span
          className="truncate text-[11px]"
          style={node ? { color: '#334155' } : { color: '#94a3b8' }}
        >
          {node ? node.label : '未选中节点'}
        </span>
      </span>

      {/* 每个按钮都带图标：只靠「+子 / +同级」这种缩写，
          第一次用的人得逐个悬停看 title 才知道是什么。 */}
      <Btn
        disabled={!usable}
        onClick={onRename}
        title="重命名选中节点（F2）"
        icon={<PencilIcon size={13} />}
      >
        改名
      </Btn>
      <Btn
        disabled={!usable}
        onClick={onAddChild}
        title="在选中节点下新增子节点（Tab）"
        icon={<PlusIcon size={13} />}
      >
        +子
      </Btn>
      <Btn
        disabled={!usable}
        onClick={onAddSibling}
        title="在选中节点后新增同级节点（Enter）"
        icon={<PlusIcon size={13} />}
      >
        +同级
      </Btn>
      {/* 笔记节点：不挂时间轴，父节点的时间范围也不会因为它而改变。
          场景是「自己的想法 / 待办 / 与视频无直接对应的补充」，
          硬给它挂时间只会污染时间轴。
          这里用纯图标：右栏只有 460px，再加一个带文字的按钮，
          「当前节点名」就会被压成「空…」——名字比这两个字更值得占地方。
          图标与笔记节点的外观同源（便签），认起来不费劲。 */}
      <button
        onClick={onAddNote}
        disabled={!usable}
        title="在选中节点下新增一条笔记：没有时间范围，也不影响父节点的时间范围"
        aria-label="新增笔记节点"
        data-role="add-note"
        className={[
          'shrink-0 inline-flex items-center justify-center h-6 w-6 rounded border transition',
          usable
            ? 'border-gray-200 bg-white text-amber-600 hover:bg-amber-50 hover:text-amber-700'
            : 'border-gray-200 bg-white text-gray-300 cursor-not-allowed',
        ].join(' ')}
      >
        <NoteIcon size={14} />
      </button>
      {/* 时间只对**叶子**开放：有子节点的节点，范围由子节点算出来
          （起点=最早子节点起点，终点=最晚子节点终点），手填没有意义；
          笔记节点根本没有时间轴。 */}
      <Btn
        disabled={!usable || !!node?.timedChildren || !!node?.note}
        onClick={onEditTime}
        title={
          node?.note
            ? '笔记节点没有时间范围（它不对应视频里的某一段）'
            : node?.timedChildren
              ? '该节点有子节点，时间范围由子节点自动决定（起点取最早、终点取最晚）'
              : '设置/修改选中节点的开始与结束时间'
        }
        icon={<ClockIcon size={13} />}
      >
        时间
      </Btn>
      <Btn
        disabled={!usable || !node?.hasChildren}
        onClick={onToggleCollapse}
        title="折叠或展开选中分支（Ctrl+/）"
        icon={node?.collapsed ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
      >
        {node?.collapsed ? '展开' : '折叠'}
      </Btn>
      {/* 删除收成纯图标：右栏只有 460px，七个带文字的按钮一排塞不下，
          换行的结果是把「当前节点名」压成「补…」，比少两个字的损失大得多。
          图标按钮同样有 24×24 触控区与 aria-label/title（见 icons.tsx 的约定）。 */}
      <button
        onClick={onRemove}
        disabled={!usable}
        title="删除选中节点及其子节点（Delete）"
        aria-label="删除"
        className={[
          'shrink-0 inline-flex items-center justify-center h-6 w-6 rounded border transition',
          usable
            ? 'border-transparent text-red-600 hover:bg-red-50 hover:border-red-200'
            : 'border-transparent text-gray-300 cursor-not-allowed',
        ].join(' ')}
      >
        <TrashIcon size={14} />
      </button>
    </div>
  )
}

function Btn({
  children,
  onClick,
  title,
  disabled,
  danger,
  icon,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  danger?: boolean
  /** 图标；不传就是纯文字按钮，高度与图标版一致 */
  icon?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        // MIN_TAPPABLE 保底 24px：原来 py-1 + text-[11px] 只有 23px，
        // 比旁边带图标的按钮矮 1px，一排看过去是斜的
        'shrink-0 gap-1 text-[11px] leading-none px-2 rounded border transition',
        MIN_TAPPABLE,
        disabled
          ? 'border-gray-200 bg-white text-gray-300 cursor-not-allowed'
          : danger
            ? 'border-transparent text-red-600 hover:bg-red-50 hover:border-red-200'
            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-900',
      ].join(' ')}
    >
      {icon}
      {children}
    </button>
  )
}
