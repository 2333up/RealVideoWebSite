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
  collapsed: boolean
}

interface Props {
  node: ToolBarNodeInfo | null
  editable: boolean
  onRename: () => void
  onAddChild: () => void
  onAddSibling: () => void
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

      <Btn disabled={!usable} onClick={onRename} title="重命名选中节点（F2）">
        改名
      </Btn>
      <Btn disabled={!usable} onClick={onAddChild} title="在选中节点下新增子节点（Tab）">
        +子
      </Btn>
      <Btn
        disabled={!usable}
        onClick={onAddSibling}
        title="在选中节点后新增同级节点（Enter）"
      >
        +同级
      </Btn>
      <Btn disabled={!usable} onClick={onEditTime} title="设置/修改选中节点的时间戳">
        时间
      </Btn>
      <Btn
        disabled={!usable || !node?.hasChildren}
        onClick={onToggleCollapse}
        title="折叠或展开选中分支（Ctrl+/）"
      >
        {node?.collapsed ? '展开' : '折叠'}
      </Btn>
      <Btn
        disabled={!usable}
        onClick={onRemove}
        danger
        title="删除选中节点及其子节点（Delete）"
      >
        删除
      </Btn>
    </div>
  )
}

function Btn({
  children,
  onClick,
  title,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'shrink-0 text-[11px] leading-none px-2 py-1 rounded border transition',
        disabled
          ? 'border-gray-200 bg-white text-gray-300 cursor-not-allowed'
          : danger
            ? 'border-transparent text-red-600 hover:bg-red-50 hover:border-red-200'
            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-900',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
