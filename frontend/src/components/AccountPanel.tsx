import { useState } from 'react'
import { api, type AccountBrief, type PlatformMeta } from '../api/client'

interface Props {
  open: boolean
  platforms: PlatformMeta[]
  accounts: AccountBrief[]
  onClose: () => void
  onRequestLogin: (platform: PlatformMeta) => void
  onRefresh: () => void
}

const HEALTH_STYLE: Record<string, { label: string; cls: string }> = {
  valid: { label: '登录正常', cls: 'bg-green-50 text-green-700' },
  expired: { label: '已失效', cls: 'bg-amber-50 text-amber-700' },
  invalid: { label: '凭据损坏', cls: 'bg-red-50 text-red-700' },
  error: { label: '校验异常', cls: 'bg-red-50 text-red-700' },
}

export default function AccountPanel({
  open, accounts, platforms, onClose, onRequestLogin, onRefresh,
}: Props) {
  const [busy, setBusy] = useState(false)
  // 当前展开「手动注入 Cookie」表单的平台（一次只展开一个）
  const [manualFor, setManualFor] = useState<string | null>(null)
  const [cookieStr, setCookieStr] = useState('')
  const [nickname, setNickname] = useState('')
  const [message, setMessage] = useState('')

  const handleInject = async (platformKey: string) => {
    if (!cookieStr.trim()) {
      setMessage('请先粘贴 Cookie 内容')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const res = await api.addManualCredential(platformKey, cookieStr.trim(), nickname)
      setMessage(res.message)
      setCookieStr('')
      setNickname('')
      setManualFor(null)
      onRefresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '注入失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('确定要删除这个账号吗？删除后将以游客身份检索。')) return
    setBusy(true)
    try {
      await api.deleteAccount(id)
      onRefresh()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDefault = async (id: number) => {
    setBusy(true)
    try {
      await api.setDefaultAccount(id)
      onRefresh()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '设置失败')
    } finally {
      setBusy(false)
    }
  }

  const handleVerify = async () => {
    setBusy(true)
    try {
      await api.verifyAccounts()
      onRefresh()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '体检失败')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/25 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="animate-pop-in h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-lifted"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink-900">平台账号</h2>
            <p className="mt-0.5 text-xs text-ink-500">凭据经加密保存在本机数据库</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-300 transition-colors hover:bg-slate-100 hover:text-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3">
          {platforms.map((platform) => {
            const owned = accounts.filter((a) => a.platform === platform.key)
            return (
              <section key={platform.key} className="surface p-4">
                <header className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: platform.accent_color }}
                    />
                    <h3 className="text-sm font-semibold text-ink-900">{platform.display_name}</h3>
                    <span className="chip bg-slate-100 text-ink-500">{owned.length} 个账号</span>
                  </div>
                  {platform.supports_login ? (
                    <button
                      type="button"
                      onClick={() => onRequestLogin(platform)}
                      className="btn-ghost !px-3 !py-1.5 !text-xs"
                    >
                      + 扫码登录
                    </button>
                  ) : platform.manual_credential ?? !platform.supports_login ? (
                    <button
                      type="button"
                      onClick={() => {
                        setManualFor(manualFor === platform.key ? null : platform.key)
                        setMessage('')
                      }}
                      className="btn-ghost !px-3 !py-1.5 !text-xs"
                    >
                      {manualFor === platform.key ? '收起' : '+ 注入 Cookie'}
                    </button>
                  ) : null}
                </header>

                {/* 手动注入 Cookie 表单（无扫码流程的平台） */}
                {manualFor === platform.key ? (
                  <div className="mb-3 rounded-xl border border-ink-100 bg-slate-50/70 p-3">
                    <p className="mb-2 text-[11px] leading-relaxed text-ink-500">
                      在浏览器打开{' '}
                      <a
                        href={platform.homepage}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-bilibili underline"
                      >
                        {platform.display_name}
                      </a>{' '}
                      并登录，按 <strong>F12</strong> → Network → 任选一个请求 →
                      在 Request Headers 里找到 <code>cookie</code>，复制其完整值粘贴到下方。
                    </p>
                    <textarea
                      value={cookieStr}
                      onChange={(e) => setCookieStr(e.target.value)}
                      rows={4}
                      placeholder="在此粘贴 Cookie，例如：sessionid=xxx; ttwid=yyy; ..."
                      className="w-full resize-none rounded-lg border border-ink-100 bg-white px-2.5 py-2
                                 text-[11px] leading-relaxed text-ink-900 outline-none
                                 focus:border-ink-300"
                    />
                    <div className="mt-2 flex gap-2">
                      <input
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        placeholder="备注名（可选）"
                        className="min-w-0 flex-1 rounded-lg border border-ink-100 bg-white px-2.5 py-1.5
                                   text-xs outline-none focus:border-ink-300"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleInject(platform.key)}
                        className="btn-primary shrink-0 !px-4 !py-1.5 !text-xs"
                      >
                        {busy ? '验证中…' : '验证并保存'}
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
                      Cookie 仅加密保存在本机，用于向平台发起请求；可随时删除。
                    </p>
                  </div>
                ) : null}

                {message ? (
                  <p className="mb-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700">
                    {message}
                  </p>
                ) : null}

                {owned.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-ink-300">
                    尚未绑定账号，当前以游客身份检索
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {owned.map((account) => {
                      const health = account.health
                        ? HEALTH_STYLE[account.health]
                        : { label: '未体检', cls: 'bg-slate-100 text-ink-500' }
                      return (
                        <li
                          key={account.id}
                          className="flex items-center gap-3 rounded-xl border border-ink-100 p-2.5"
                        >
                          {account.avatar_url ? (
                            <img
                              src={account.avatar_url}
                              alt={account.nickname}
                              referrerPolicy="no-referrer"
                              className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-ink-100"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.visibility = 'hidden'
                              }}
                            />
                          ) : (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm">
                              👤
                            </div>
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium text-ink-900">
                                {account.nickname || `UID ${account.platform_uid}`}
                              </span>
                              {account.is_default ? (
                                <span className="chip !px-1.5 !py-0.5 bg-bilibili-soft text-bilibili">
                                  默认
                                </span>
                              ) : null}
                            </div>
                            <span className={`chip mt-1 !px-1.5 !py-0 ${health.cls}`}>
                              {health.label}
                            </span>
                          </div>

                          <div className="flex shrink-0 flex-col gap-1">
                            {!account.is_default ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleDefault(account.id)}
                                className="rounded-md px-2 py-1 text-[11px] text-ink-500 transition-colors hover:bg-slate-100 hover:text-ink-900"
                              >
                                设默认
                              </button>
                            ) : null}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDelete(account.id)}
                              className="rounded-md px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50"
                            >
                              删除
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}

              </section>
            )
          })}
        </div>

        <button
          type="button"
          onClick={handleVerify}
          disabled={busy || accounts.length === 0}
          className="btn-ghost mt-5 w-full"
        >
          {busy ? '正在体检…' : '体检全部账号登录态'}
        </button>

        <p className="mt-4 text-[11px] leading-relaxed text-ink-300">
          登录态过期不会影响继续使用，系统会自动降级为游客检索。
          凭据采用对称加密存储，密钥保存在服务端 data 目录。
        </p>
      </aside>
    </div>
  )
}
