import { useEffect, useState } from 'react'
import { api } from '../api'
import type { UsageReport } from '../types'
import { CloseIcon, IconButton } from './icons'

interface Props {
  onClose: () => void
}

/** 千分位 + 中文单位：12345 -> 1.23 万，避免长数字看不清量级 */
function fmt(n: number): string {
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(2)} 亿`
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(2)} 万`
  return n.toLocaleString('zh-CN')
}

function Bar({ label, value, max, sub }: { label: string; value: number; max: number; sub?: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return (
    <div className="mb-2">
      <div className="flex items-baseline justify-between text-[11px] mb-1">
        <span className="text-gray-700 truncate" title={label}>
          {label}
        </span>
        <span className="tabular-nums text-gray-500 shrink-0 ml-2">
          {fmt(value)} {sub && <span className="text-gray-400">{sub}</span>}
        </span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function UsagePanel({ onClose }: Props) {
  const [data, setData] = useState<UsageReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    api
      .getUsage()
      .then(setData)
      .catch((e) => setError(String((e as Error).message || e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-gray-200 flex items-center shrink-0">
          <h2 className="text-sm font-semibold text-gray-900">大模型用量</h2>
          <span className="text-[11px] text-gray-400 ml-2">按每次调用记录，可随时查看</span>
          <IconButton
            icon={<CloseIcon size={18} />}
            label="关闭"
            onClick={onClose}
            className="ml-auto hover:text-gray-700 hover:bg-gray-100"
          />
        </div>

        <div className="flex-1 overflow-y-auto thin-scroll p-5">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">
              {error}
            </div>
          )}
          {loading && <div className="text-xs text-gray-400 py-8 text-center">加载中…</div>}

          {data && data.totals.calls === 0 && (
            <div className="text-xs text-gray-400 py-10 text-center">
              还没有任何用量记录。分析一个视频后这里就会有数据。
            </div>
          )}

          {data && data.totals.calls > 0 && (
            <>
              {/* 总览 */}
              <div className="grid grid-cols-4 gap-2 mb-5">
                {[
                  ['总调用', fmt(data.totals.calls), '次'],
                  ['输入 token', fmt(data.totals.prompt_tokens), ''],
                  ['输出 token', fmt(data.totals.completion_tokens), ''],
                  ['合计', fmt(data.totals.total_tokens), ''],
                ].map(([label, value, unit]) => (
                  <div key={label} className="bg-gray-50 rounded-lg px-3 py-2.5">
                    <div className="text-[10px] text-gray-500">{label}</div>
                    <div className="text-base font-semibold text-gray-900 tabular-nums mt-0.5">
                      {value}
                      <span className="text-[10px] font-normal text-gray-400 ml-0.5">{unit}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* 按用途：回答「钱花在哪一步」 */}
              <Section title="按用途">
                {data.by_purpose.map((r) => (
                  <Bar
                    key={r.key}
                    label={r.key}
                    value={r.total_tokens}
                    max={Math.max(...data.by_purpose.map((x) => x.total_tokens))}
                    sub={`${r.calls} 次`}
                  />
                ))}
              </Section>

              <Section title="按模型">
                {data.by_model.map((r) => (
                  <Bar
                    key={r.key}
                    label={r.key}
                    value={r.total_tokens}
                    max={Math.max(...data.by_model.map((x) => x.total_tokens))}
                    sub={`${r.calls} 次`}
                  />
                ))}
              </Section>

              <Section title="按视频">
                {data.by_video.map((r) => (
                  <Bar
                    key={String(r.video_id)}
                    label={r.title || '（未关联视频）'}
                    value={r.total_tokens}
                    max={Math.max(...data.by_video.map((x) => x.total_tokens))}
                    sub={`${r.calls} 次`}
                  />
                ))}
              </Section>

              {/* 明细：最多展示最近的调用，避免长列表拖垮渲染 */}
              <Section title={`最近调用（最多 ${Math.min(data.items.length, 30)} 条）`}>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-[11px]">
                    <thead className="bg-gray-50 text-gray-500">
                      <tr>
                        <th className="text-left px-2.5 py-1.5 font-medium">时间</th>
                        <th className="text-left px-2.5 py-1.5 font-medium">用途</th>
                        <th className="text-left px-2.5 py-1.5 font-medium">模型</th>
                        <th className="text-right px-2.5 py-1.5 font-medium">输入</th>
                        <th className="text-right px-2.5 py-1.5 font-medium">输出</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.slice(0, 30).map((r) => (
                        <tr key={r.id} className="border-t border-gray-100">
                          <td className="px-2.5 py-1.5 text-gray-400 tabular-nums">
                            {r.created_at ? r.created_at.slice(5, 19).replace('T', ' ') : '-'}
                          </td>
                          <td className="px-2.5 py-1.5 text-gray-700">{r.purpose || '-'}</td>
                          <td className="px-2.5 py-1.5 text-gray-500">{r.model || '-'}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-gray-600">
                            {fmt(r.prompt_tokens)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-gray-600">
                            {fmt(r.completion_tokens)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          )}
        </div>

        {data && data.totals.calls > 0 && (
          <div className="px-5 py-3 border-t border-gray-200 flex items-center shrink-0">
            <button
              onClick={load}
              className="text-[11px] px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
            >
              刷新
            </button>
            <button
              onClick={() => {
                if (!confirm('清空全部用量记录？此操作不可恢复。')) return
                api.clearUsage().then(load).catch((e) => setError(String(e)))
              }}
              className="ml-auto text-[11px] px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50"
            >
              清空记录
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-[11px] font-medium text-gray-500 mb-2">{title}</h3>
      {children}
    </div>
  )
}
