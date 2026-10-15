import { useCallback, useEffect, useMemo } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import type { MindMapNode } from '../types'
import { layoutMindMap } from '../lib/mindmapLayout'
import { formatTs } from '../lib/format'

interface MindNodeData extends Record<string, unknown> {
  label: string
  start: number | null
  depth: number
  active: boolean
  onSeek: (t: number) => void
}

type MindFlowNode = Node<MindNodeData>

/**
 * 自定义节点。
 *
 * 视觉上用「左边框的颜色条」表达层级：根=深色、一级=蓝、二级=青，
 * 这样即使不依赖颜色也能靠深浅分辨层次（照顾色觉障碍用户）。
 */
function MindNode({ data }: NodeProps) {
  const d = data as MindNodeData
  const depth = d.depth ?? 0

  const barColor =
    depth === 0 ? '#4f46e5' : depth === 1 ? '#2563eb' : depth === 2 ? '#0891b2' : '#64748b'

  const bg =
    depth === 0
      ? 'bg-indigo-50 border-indigo-300'
      : depth === 1
        ? 'bg-blue-50 border-blue-200'
        : 'bg-white border-gray-200'

  return (
    <>
      {/*
        Handle 是 ReactFlow 画连线的锚点：自定义节点必须自己渲染它，
        否则整棵树的边会被静默丢弃——节点照常显示、连线一条没有，
        而且不报任何错，表现为「看不出层级关系」却查不出原因。
        外观交给 index.css 的 .react-flow__handle{opacity:0} 隐藏，
        交互也不用它，节点整体就是点击热区。
      */}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div
        onClick={() => d.start !== null && d.onSeek(d.start)}
        title={d.start !== null ? `跳转到 ${formatTs(d.start)}` : '该节点无对应时间点'}
        className={[
          'flex items-center gap-2 rounded-md border px-3 py-2 shadow-sm transition',
          'hover:shadow-md hover:-translate-y-px',
          bg,
          d.active ? 'ring-2 ring-blue-500 border-blue-500' : '',
          d.start === null ? 'cursor-default opacity-70' : 'cursor-pointer',
        ].join(' ')}
        style={{ width: '100%', height: '100%' }}
      >
        <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: barColor }} />
        <span
          className={[
            'text-[13px] leading-tight truncate',
            depth === 0 ? 'font-semibold text-indigo-900' : 'text-gray-800',
          ].join(' ')}
        >
          {d.label}
        </span>
        {d.start !== null && (
          <span className="ml-auto text-[10px] tabular-nums text-gray-400 shrink-0">
            {formatTs(d.start)}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}

const nodeTypes = { mind: MindNode }

interface Props {
  tree: MindMapNode
  currentTime: number
  onSeek: (t: number) => void
}

export default function MindMap({ tree, currentTime, onSeek }: Props) {
  // 计算「当前所处节点」：取所有 start <= currentTime 中 start 最大的那个。
  // 这比「判断落在区间内」更稳——节点时间戳是稀疏的，区间判断会频繁落空。
  // 用两个基础类型变量而不是一个对象：闭包内对对象反复赋值会让 TS 的控制流
  // 推断退化成 never，拆成基础类型既绕开这个问题，意图也更直白。
  const activeId = useMemo(() => {
    let bestId: string | null = null
    let bestStart = -Infinity
    const walk = (node: MindMapNode, id: string) => {
      const s = node.start
      if (s !== null && s !== undefined && s <= currentTime && s > bestStart) {
        bestId = id
        bestStart = s
      }
      ;(node.children ?? []).forEach((c, i) => walk(c, `${id}-${i}`))
    }
    walk(tree, 'n0')
    return bestId
  }, [tree, currentTime])

  const { nodes, edges } = useMemo(() => {
    const layout = layoutMindMap(tree)
    const byId = new Map(layout.nodes.map((n) => [n.id, n]))

    const flowNodes: MindFlowNode[] = layout.nodes.map((n) => ({
      id: n.id,
      type: 'mind',
      position: { x: n.x, y: n.y },
      // 让自定义节点撑满布局算出的宽高，文字截断交给节点内部处理
      style: { width: n.width, height: n.height, padding: 0, border: 'none', background: 'transparent' },
      data: {
        label: n.label,
        start: n.start,
        depth: n.depth,
        active: n.id === activeId,
        onSeek,
      },
      draggable: false,
      connectable: false,
    }))

    // 连线必须自己带层级语义：只画灰线的话，用户看到的是一堆散落的方框，
    // 看不出「谁属于谁」。这里按目标节点深度配色 + 加箭头指明方向，
    // 让「根 → 章节 → 要点」的归属一眼可读。
    const flowEdges: Edge[] = []
    for (const n of layout.nodes) {
      if (!n.parentId) continue
      const parent = byId.get(n.parentId)
      if (!parent) continue
      const color = n.depth <= 1 ? '#818cf8' : '#a5b4fc'
      flowEdges.push({
        id: `e-${n.parentId}-${n.id}`,
        source: n.parentId,
        target: n.id,
        type: 'smoothstep',
        style: { stroke: color, strokeWidth: n.depth <= 1 ? 2 : 1.5 },
        // 箭头是「归属方向」的关键，比单纯的颜色更能消除歧义
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color,
        },
      })
    }
    return { nodes: flowNodes, edges: flowEdges }
  }, [tree, activeId, onSeek])

  // 节点数据变化（尤其是 active 高亮）时需要通知 ReactFlow 重新测量
  const key = useMemo(() => nodes.map((n) => `${n.id}:${n.data.active ? 1 : 0}`).join('|'), [nodes])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const d = node.data as unknown as MindNodeData
      if (d?.start !== null && d?.start !== undefined) onSeek(d.start)
    },
    [onSeek],
  )

  useEffect(() => {
    // 导图树本身变化时（重新分析后）无需额外处理，useMemo 会自动重算
  }, [tree])

  return (
    <div className="w-full h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      <ReactFlow
        key={key}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        panOnDrag
        zoomOnScroll
      >
        <Background color="#eef1f5" gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => ((n.data as unknown as MindNodeData)?.depth === 0 ? '#4f46e5' : '#93c5fd')}
          style={{ background: '#f8fafc' }}
        />
      </ReactFlow>
    </div>
  )
}
