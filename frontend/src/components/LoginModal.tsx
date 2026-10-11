import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AccountBrief, type PlatformMeta } from '../api/client'

type Phase = 'idle' | 'loading' | 'waiting' | 'scanned' | 'success' | 'expired' | 'error'

const PHASE_TEXT: Record<Phase, { title: string; tone: string }> = {
  idle: { title: '正在准备…', tone: 'text-ink-500' },
  loading: { title: '正在获取二维码…', tone: 'text-ink-500' },
  waiting: { title: '请使用 哔哩哔哩 App 扫码', tone: 'text-ink-700' },
  scanned: { title: '已扫码，请在手机上确认', tone: 'text-blue-600' },
  success: { title: '登录成功', tone: 'text-green-600' },
  expired: { title: '二维码已失效', tone: 'text-amber-600' },
  error: { title: '登录失败', tone: 'text-red-600' },
}

interface Props {
  platform: PlatformMeta
  open: boolean
  onClose: () => void
  onSuccess: (account: AccountBrief) => void
}

const POLL_INTERVAL = 2200

export default function LoginModal({ platform, open, onClose, onSuccess }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [qrcode, setQrcode] = useState('')
  const [message, setMessage] = useState('')
  const tokenRef = useRef<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const stoppedRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const startLogin = useCallback(async () => {
    stoppedRef.current = false
    setPhase('loading')
    setMessage('')
    setQrcode('')
    try {
      const data = await api.loginStart(platform.key)
      if (stoppedRef.current) return
      tokenRef.current = data.token
      setQrcode(data.qrcode_image)
      setPhase('waiting')
    } catch (err) {
      if (stoppedRef.current) return
      setPhase('error')
      setMessage(err instanceof Error ? err.message : '获取二维码失败')
    }
  }, [platform.key])

  // 轮询登录状态
  useEffect(() => {
    if (!open) {
      stoppedRef.current = true
      stopPolling()
      return
    }
    if (phase !== 'waiting' && phase !== 'scanned') return
    if (!tokenRef.current) return

    const poll = async () => {
      const token = tokenRef.current
      if (!token || stoppedRef.current) return
      try {
        const data = await api.loginPoll(platform.key, token)
        if (stoppedRef.current) return

        if (data.status === 'success') {
          setPhase('success')
          setMessage(data.message)
          stopPolling()
          if (data.account) {
            onSuccess(data.account)
            // 稍作停留让用户看到成功态，再关闭弹窗
            window.setTimeout(() => onClose(), 900)
          }
          return
        }
        if (data.status === 'scanned') {
          setPhase('scanned')
          setMessage(data.message)
        } else if (data.status === 'expired') {
          setPhase('expired')
          setMessage(data.message)
          stopPolling()
          return
        } else if (data.status === 'error') {
          setPhase('error')
          setMessage(data.message)
          stopPolling()
          return
        } else {
          setMessage(data.message)
        }
        timerRef.current = window.setTimeout(poll, POLL_INTERVAL)
      } catch {
        if (stoppedRef.current) return
        setPhase('error')
        setMessage('轮询登录状态失败，请重试')
        stopPolling()
      }
    }

    timerRef.current = window.setTimeout(poll, POLL_INTERVAL)
    return stopPolling
  }, [open, phase, platform.key, onClose, onSuccess, stopPolling])

  useEffect(() => {
    if (open) {
      void startLogin()
    } else {
      stoppedRef.current = true
      stopPolling()
      setQrcode('')
      setPhase('idle')
      setMessage('')
      tokenRef.current = null
    }
    return stopPolling
  }, [open, startLogin, stopPolling])

  if (!open) return null

  const text = PHASE_TEXT[phase]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="animate-pop-in w-full max-w-sm rounded-2xl bg-white p-6 shadow-lifted"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between">
          <h2 className="text-lg font-bold text-ink-900">
            登录 {platform.display_name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded-lg p-1.5 text-ink-300 transition-colors hover:bg-slate-100 hover:text-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <p className="mb-5 text-xs leading-relaxed text-ink-500">
          登录后可使用你的账号身份检索，获得更完整的结果；
          凭据将加密保存在本机，仅用于向平台发起请求。
        </p>

        <div className="flex min-h-[228px] flex-col items-center justify-center rounded-xl border border-dashed border-ink-100 bg-slate-50/70 p-4">
          {qrcode ? (
            <img src={qrcode} alt="登录二维码" className="h-44 w-44 rounded-lg bg-white p-1.5 shadow-sm" />
          ) : (phase === 'loading' || phase === 'idle') ? (
            <div className="flex flex-col items-center gap-3 text-ink-300">
              <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-ink-100 border-t-bilibili" />
              <span className="text-xs">正在生成二维码…</span>
            </div>
          ) : (
            <div className="text-3xl opacity-30">{phase === 'success' ? '✅' : '⚠️'}</div>
          )}
        </div>

        <p className={`mt-4 text-center text-sm font-medium ${text.tone}`}>{text.title}</p>
        {message ? (
          <p className="mt-1 text-center text-xs leading-relaxed text-ink-500">{message}</p>
        ) : null}

        {(phase === 'expired' || phase === 'error') && (
          <button type="button" onClick={startLogin} className="btn-primary mt-4 w-full">
            重新获取二维码
          </button>
        )}
      </div>
    </div>
  )
}
