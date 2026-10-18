import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  failed: boolean
}

/**
 * 子树的错误边界。
 *
 * 存在的理由很具体：桌宠 `<WebPet />` 挂在 `<Routes>` **之外**（为了让切页时
 * 不重新挂载、走动与位置能延续），这也意味着它一旦在渲染期抛错，React 会
 * 卸载整棵组件树 —— 灵搜和 video-mind 两个页面会一起白屏，只因为一个装饰性
 * 组件出了问题。用户的感知是「两个前端全都不好用了」，排查方向会被完全带偏。
 *
 * 所以把桌宠这类「锦上添花」的组件单独圈起来：它崩了就当没渲染，页面照常用，
 * 错误只在控制台留痕。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 子树渲染失败，已降级：', error, info.componentStack)
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null
    return this.props.children
  }
}