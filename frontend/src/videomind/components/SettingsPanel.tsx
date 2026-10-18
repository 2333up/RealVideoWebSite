import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ProviderInfo, SettingsData } from '../types'
import { CloseIcon, IconButton } from './icons'

interface Props {
  onClose: () => void
  /**
   * 只渲染「大模型」区块。
   *
   * 灵搜（搜索页）复用了这个面板 —— 它只需要配置大模型供应商与密钥，
   * 而「语音转写」「分章节参数」是 video-mind 的专属设置，出现在搜索页
   * 只会让人困惑「搜视频为什么要配 Whisper」。故由调用方按需收窄。
   *
   * 默认 false，即 video-mind 侧的行为与之前完全一致。
   */
  onlyLlm?: boolean
}

export default function SettingsPanel({ onClose, onlyLlm = false }: Props) {
  // 标题随用途变化：灵搜里叫「大模型设置」更贴合，完整面板仍叫「设置」
  const title = onlyLlm ? '大模型设置' : '设置'
  const [data, setData] = useState<SettingsData | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [customBase, setCustomBase] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    api.getSettings().then(setData).catch((e) => setError(String(e.message || e)))
  }, [])

  if (error) {
    return (
      <Modal onClose={onClose} title={title}>
        <div className="text-red-600 text-sm">加载设置失败：{error}</div>
      </Modal>
    )
  }
  if (!data) {
    return (
      <Modal onClose={onClose} title={title}>
        <div className="text-gray-400 text-sm">加载中…</div>
      </Modal>
    )
  }

  const patch = async (p: Partial<SettingsData['current']>) => {
    setSaving(true)
    try {
      await api.patchSettings(p)
      setData({ ...data, current: { ...data.current, ...p } })
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  const saveKey = async (envKey: string) => {
    const val = keys[envKey]
    if (!val) return
    setSaving(true)
    try {
      await api.setKey(envKey, val, envKey === 'CUSTOM_LLM_API_KEY' ? customBase : undefined)
      const fresh = await api.getSettings()
      setData(fresh)
      setKeys({ ...keys, [envKey]: '' })
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  const test = async (kind: 'llm' | 'asr') => {
    setTesting(true)
    setTestMsg(null)
    try {
      const r =
        kind === 'llm'
          ? await api.testConnection('llm', data.current.llm_provider, data.current.llm_model)
          : await api.testConnection('asr', data.current.asr_provider)
      setTestMsg({ ok: r.ok, text: r.message })
    } catch (e) {
      setTestMsg({ ok: false, text: String((e as Error).message || e) })
    } finally {
      setTesting(false)
    }
  }

  const curLlm = data.llm_providers.find((p) => p.id === data.current.llm_provider)
  const curAsr = data.asr_providers.find((p) => p.id === data.current.asr_provider)

  return (
    <Modal onClose={onClose} title={title}>
      <div className="space-y-6 text-sm">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 text-xs">
            {error}
          </div>
        )}

        {/* ---------------- LLM ---------------- */}
        <Section title={onlyLlm ? '大模型 API' : '大模型（分章节与导图）'}>
          <div className="grid grid-cols-3 gap-2">
            {data.llm_providers.map((p) => (
              <ProviderCard
                key={p.id}
                p={p}
                selected={data.current.llm_provider === p.id}
                onSelect={() => patch({ llm_provider: p.id, llm_model: p.default_model })}
              />
            ))}
          </div>

          {curLlm && (
            <div className="mt-3 space-y-2">
              <Field label="模型名">
                {/* datalist 而非 select：既能从候选里挑，也允许手填任意模型名 */}
                <input
                  list="llm-model-options"
                  value={data.current.llm_model}
                  onChange={(e) => setData({ ...data, current: { ...data.current, llm_model: e.target.value } })}
                  onBlur={() => patch({ llm_model: data.current.llm_model })}
                  className="border border-gray-300 rounded px-2 py-1 w-full text-xs font-mono"
                />
                <datalist id="llm-model-options">
                  {(curLlm.models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <p className="text-[11px] text-gray-400 mt-1">
                  {curLlm.models?.length
                    ? `可选：${curLlm.models.join(' / ')}（也可手动填写其他模型名）`
                    : '手动填写模型名'}
                </p>
              </Field>

              <Field label={`API Key（${curLlm.env_key}）`}>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={curLlm.key_masked || '未配置'}
                    value={keys[curLlm.env_key] ?? ''}
                    onChange={(e) => setKeys({ ...keys, [curLlm.env_key]: e.target.value })}
                    className="border border-gray-300 rounded px-2 py-1 flex-1 text-xs font-mono"
                  />
                  <button
                    onClick={() => saveKey(curLlm.env_key)}
                    disabled={!keys[curLlm.env_key] || saving}
                    className="px-3 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-40"
                  >
                    保存
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  {curLlm.key_configured
                    ? `已配置（${curLlm.key_masked}），重新填写可覆盖。密钥保存在 backend/.env`
                    : `未配置。密钥写入 backend/.env 的 ${curLlm.env_key}`}
                </p>
              </Field>

              {curLlm.id === 'custom' && (
                <Field label="服务地址（base_url）">
                  <input
                    value={customBase}
                    onChange={(e) => setCustomBase(e.target.value)}
                    placeholder="http://127.0.0.1:11434/v1"
                    className="border border-gray-300 rounded px-2 py-1 w-full text-xs font-mono"
                  />
                </Field>
              )}

              <button
                onClick={() => test('llm')}
                disabled={testing}
                className="px-3 py-1.5 rounded border border-gray-300 text-xs hover:bg-gray-50 disabled:opacity-40"
              >
                {testing ? '测试中…' : '测试连通性'}
              </button>
            </div>
          )}
        </Section>

        {/* ASR 与处理参数都属于 video-mind 的转写管线，灵搜侧不显示（onlyLlm） */}
        {!onlyLlm && (
          <>
        {/* ---------------- ASR ---------------- */}
        <Section title="语音转写（ASR）">
          <div className="grid grid-cols-3 gap-2">
            {data.asr_providers.map((p) => (
              <ProviderCard
                key={p.id}
                p={p}
                selected={data.current.asr_provider === p.id}
                onSelect={() => patch({ asr_provider: p.id })}
              />
            ))}
          </div>

          {data.current.asr_provider === 'faster_whisper' ? (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="模型大小">
                <select
                  value={data.current.whisper_model_size}
                  onChange={(e) => patch({ whisper_model_size: e.target.value })}
                  className="border border-gray-300 rounded px-2 py-1 w-full text-xs"
                >
                  {['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3', 'large-v3-turbo'].map(
                    (m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="运行设备">
                <select
                  value={data.current.whisper_device}
                  onChange={(e) => patch({ whisper_device: e.target.value })}
                  className="border border-gray-300 rounded px-2 py-1 w-full text-xs"
                >
                  <option value="auto">auto（自动探测）</option>
                  <option value="cuda">cuda（GPU）</option>
                  <option value="cpu">cpu</option>
                </select>
              </Field>
              <p className="col-span-2 text-[11px] text-gray-500">
                当前解析结果：<b>{data.resolved_whisper.device}</b> /{' '}
                <b>{data.resolved_whisper.compute_type}</b>
                <span className="text-gray-400">（auto 模式会自动探测 CUDA；CPU 上自动用 int8）</span>
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <Field label={`API Key（${curAsr?.env_key ?? ''}）`}>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={curAsr?.key_masked || '未配置'}
                    value={keys[curAsr?.env_key ?? ''] ?? ''}
                    onChange={(e) => setKeys({ ...keys, [curAsr?.env_key ?? '']: e.target.value })}
                    className="border border-gray-300 rounded px-2 py-1 flex-1 text-xs font-mono"
                  />
                  <button
                    onClick={() => curAsr && saveKey(curAsr.env_key)}
                    disabled={!keys[curAsr?.env_key ?? ''] || saving}
                    className="px-3 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-40"
                  >
                    保存
                  </button>
                </div>
              </Field>
              <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded px-3 py-2 text-[11px] leading-relaxed">
                <b>注意：</b>多数云端 ASR 只返回纯文本、不带时间戳。本项目依赖精确时间戳实现跳转，
                若服务端不返回片段时间，会直接报错而不会用估算值填充——请改用本地 faster-whisper。
              </div>
            </div>
          )}
        </Section>

        {/* ---------------- 管线 ---------------- */}
        <Section title="处理参数">
          <div className="grid grid-cols-2 gap-3">
            <Field label="分章节单片字符数">
              <input
                type="number"
                value={data.current.chapter_target_chars}
                onChange={(e) =>
                  setData({
                    ...data,
                    current: { ...data.current, chapter_target_chars: Number(e.target.value) },
                  })
                }
                onBlur={() => patch({ chapter_target_chars: data.current.chapter_target_chars })}
                className="border border-gray-300 rounded px-2 py-1 w-full text-xs"
              />
            </Field>
            <Field label="转写语言">
              <input
                value={data.current.language}
                onChange={(e) => setData({ ...data, current: { ...data.current, language: e.target.value } })}
                onBlur={() => patch({ language: data.current.language })}
                placeholder="zh / en / 留空自动检测"
                className="border border-gray-300 rounded px-2 py-1 w-full text-xs"
              />
            </Field>
            <Field label="超时（秒）">
              <input
                type="number"
                value={data.current.llm_timeout_s}
                onChange={(e) =>
                  setData({ ...data, current: { ...data.current, llm_timeout_s: Number(e.target.value) } })
                }
                onBlur={() => patch({ llm_timeout_s: data.current.llm_timeout_s })}
                className="border border-gray-300 rounded px-2 py-1 w-full text-xs"
              />
            </Field>
          </div>
        </Section>

          </>
        )}

        {testMsg && (
          <div
            className={[
              'rounded px-3 py-2 text-xs border',
              testMsg.ok
                ? 'bg-green-50 border-green-200 text-green-700'
                : 'bg-red-50 border-red-200 text-red-700',
            ].join(' ')}
          >
            {testMsg.text}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ 小组件

function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto thin-scroll"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b px-5 py-3 flex items-center">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <IconButton
            icon={<CloseIcon size={18} />}
            label="关闭"
            onClick={onClose}
            className="ml-auto hover:text-gray-700 hover:bg-gray-100"
          />
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-medium text-gray-800 mb-2 pb-1 border-b border-gray-100">{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  )
}

function ProviderCard({
  p,
  selected,
  onSelect,
}: {
  p: ProviderInfo
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={[
        'text-left rounded-lg border px-3 py-2 transition',
        selected
          ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-300'
          : 'border-gray-200 bg-white hover:border-blue-300',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-gray-900">{p.name}</span>
        {p.key_configured && p.requires_key && (
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="密钥已配置" />
        )}
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5 leading-tight">{p.note}</div>
    </button>
  )
}
