/**
 * 跳转请求。
 *
 * 为什么是一个对象而不是一个数字：
 *   如果只传秒数，用户连续点击同一个章节两次，React 会因为值没变而不触发
 *   副作用，表现为「点了没反应」。带上唯一 requestId 后每次点击都是新对象，
 *   重复点击也能可靠地重新定位。
 *
 * 这个思路来自对 vsummary 实现的阅读（useWorkspaceController 里的
 * `requestId: Date.now()-seconds`），是这类联动组件里很容易踩的一个坑。
 */

export interface SeekRequest {
  seconds: number
  endSeconds?: number | null
  requestId: string
}

let seq = 0

export function makeSeekRequest(seconds: number, endSeconds?: number | null): SeekRequest {
  seq += 1
  return {
    seconds,
    endSeconds: endSeconds ?? null,
    requestId: `${Date.now()}-${seq}-${seconds}`,
  }
}
