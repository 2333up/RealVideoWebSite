export interface HighlightPart {
  text: string
  hit: boolean
}

/**
 * 把一段文本按关键词切成「命中 / 未命中」的片段，交给视图层自己决定怎么上色。
 *
 * 用 indexOf 循环而不是正则：关键词直接来自用户输入，
 * 一旦进了正则，`(`、`*`、`[` 这些字符要么抛错要么匹配错乱。
 */
export function splitHighlight(text: string, query: string): HighlightPart[] {
  const q = query.trim()
  if (!q) return [{ text, hit: false }]

  const lower = text.toLowerCase()
  const target = q.toLowerCase()
  const parts: HighlightPart[] = []
  let idx = 0
  let pos = lower.indexOf(target)

  while (pos !== -1) {
    if (pos > idx) parts.push({ text: text.slice(idx, pos), hit: false })
    parts.push({ text: text.slice(pos, pos + q.length), hit: true })
    idx = pos + q.length
    pos = lower.indexOf(target, idx)
  }
  if (idx < text.length) parts.push({ text: text.slice(idx), hit: false })
  return parts
}
