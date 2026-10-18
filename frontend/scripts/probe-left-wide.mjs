/**
 * 左栏「宽/窄两种形态」的冒烟。
 *
 * 背景（2026-10-18 用户截图）：把左栏拉宽之后，内容没跟着放开——
 * 视频行还是 24px 高、11px 字，中间撑出一大片空白，看着像没加载完。
 *
 * 现在按左栏宽度切两档（阈值 420px，见 VideoMindApp 的 leftWide）：
 *   窄：行高 24px、11px 字、体积收进 tooltip（尽量多塞几条）
 *   宽：行高 32px、13px 字、体积摊到右边、两个导入按钮并排
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-left-wide.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] ?? (await browser.newContext())
const page = await context.newPage()
await page.setViewportSize({ width: 1600, height: 1000 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

/** 用固定宽度打开页面（直接写布局存档，比拖分割线稳定） */
async function atWidth(w) {
  await page.goto(BASE + '/videomind/', { waitUntil: 'domcontentloaded' })
  await page.evaluate((width) => {
    localStorage.setItem(
      'video-mind:layout.v1',
      JSON.stringify({ leftWidth: width, rightWidth: 460, leftOpen: true, rightOpen: true }),
    )
  }, w)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // 展开所有分类，让视频行可见
  for (let i = 0; i < 4; i += 1) {
    await page.evaluate(() => {
      for (const r of document.querySelectorAll(
        '[data-panel="left"] [data-folder-row][data-expanded="false"]',
      )) {
        r.click()
      }
    })
    await page.waitForTimeout(200)
  }
}

/** 量视频行：高度、标题字号、右侧有没有体积文本 */
const rowMetrics = () =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-panel="left"] div.cursor-pointer')].find(
      (x) => !x.hasAttribute('data-folder-row'),
    )
    if (!row) return null
    const title = row.querySelector('span.min-w-0')
    const btn = row.querySelector('button')
    const importBtns = [...document.querySelectorAll('button')].filter((b) =>
      /选择视频文件导入|选择文件夹批量导入/.test(b.textContent || ''),
    )
    return {
      h: Math.round(row.getBoundingClientRect().height),
      fontPx: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
      // 体积形如「488.8 MB」，窄面板里应该看不到
      hasSize: /\d+(\.\d+)?\s?(B|KB|MB|GB)/.test(row.textContent || ''),
      iconSize: btn ? Math.round(btn.getBoundingClientRect().width) : 0,
      importSideBySide:
        importBtns.length === 2 &&
        Math.abs(importBtns[0].getBoundingClientRect().top - importBtns[1].getBoundingClientRect().top) < 2,
    }
  })

// ================= A. 窄（默认 256）=================
console.log('\n[A] 窄面板（256px）')
await atWidth(256)
const narrow = await rowMetrics()
console.log('  info', JSON.stringify(narrow))
check('行高保持 24px 的密集形态', narrow?.h === 24, `${narrow?.h}px`)
check('标题仍是 11px', narrow?.fontPx === 11, `${narrow?.fontPx}px`)
check('体积不占行内空间（收进 tooltip）', narrow?.hasSize === false)
check('两个导入按钮上下摞着', narrow?.importSideBySide === false)

// ================= B. 宽（560）=================
console.log('\n[B] 宽面板（560px）')
await atWidth(560)
const wide = await rowMetrics()
console.log('  info', JSON.stringify(wide))
check('行高放开到 32px', wide?.h === 32, `${wide?.h}px`)
check('标题放大到 13px', wide?.fontPx === 13, `${wide?.fontPx}px`)
check('体积摊到行内（把空白填上）', wide?.hasSize === true)
check('两个导入按钮并排', wide?.importSideBySide === true)
check('图标跟着放大（≥24×24）', (wide?.iconSize ?? 0) >= 24, `${wide?.iconSize}px`)

// ================= C. 拖回窄，形态要回来 =================
console.log('\n[C] 再收窄')
await atWidth(320)
const back = await rowMetrics()
check('收窄后回到密集形态', back?.h === 24 && back?.fontPx === 11, JSON.stringify(back))
check('体积重新收进 tooltip', back?.hasSize === false)

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

// 收尾：还原成默认布局，别把 320 留给下一个脚本
await page.evaluate(() => localStorage.removeItem('video-mind:layout.v1'))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
await page.close()
console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
