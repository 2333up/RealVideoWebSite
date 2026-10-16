import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 端口必须与「灵搜 LingoSeek」错开：两个项目共用本仓库，
    // 都用 5173 的话，后启动的 vite 会被挤到 IPv6([::1]:5173) 且不报错，
    // 浏览器访问 127.0.0.1 却永远命中先占 IPv4 的那个 ——
    // 表现为「页面上找不到自己项目的按钮」，极难排查。
    // strictPort 让端口被占时直接失败，绝不静默漂移。
    port: 5273,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      // 后端已与 lingoSeek 合并为单一服务，统一跑在 8000。
      // video-mind 的接口整体挂在 /videomind 前缀下，这里把 /api、/artifacts
      // 转发到 8000 并补上 /videomind 前缀，前端业务代码无需任何改动。
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => '/videomind' + path,
      },
      '/artifacts': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => '/videomind' + path,
      },
    },
  },
})
