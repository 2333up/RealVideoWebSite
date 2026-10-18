/**
 * 播放器「加载卡住」的兜底冒烟。
 *
 * 背景（2026-10-18 用户反馈）：点思维导图节点后，视频区一直停在
 * 「加载视频中…」，播放按钮不出现，只能整个退出。
 * 根因是流被卡住时 `<video>` 既不报错也不发 loadedmetadata，界面就一直死等。
 *
 * 这个脚本**主动把流掐住**来复现那种状态，然后验证：
 *   1. 卡住期间确实是「加载视频中…」（复现用户看到的现象）
 *   2. 超过看门狗时长后换成「视频加载超时」+「重新加载」
 *   3. 放开流、点「重新加载」能恢复正常播放（不用退出重进）
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-player-load.mjs
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
await page.setViewportSize({ width: 1440, height: 900 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

const STREAM = '**/videomind/api/videos/*/stream*'

/** 页面上的三种状态：加载中 / 超时 / 就绪 */
const state = () =>
  page.evaluate(() => {
    const txt = document.body.innerText
    return {
      loading: txt.includes('加载视频中'),
      timeout: txt.includes('视频加载超时'),
      retryBtn: [...document.querySelectorAll('button')].some(
        (b) => (b.textContent || '').trim() === '重新加载',
      ),
      playBtn: !!document.querySelector('[data-player-stage] button[aria-label="播放"]'),
      readyState: document.querySelector('video')?.readyState ?? -1,
    }
  })

// 掐住视频流：`hold` 期间只挂起、不响应，模拟「服务端不吐数据」；
// 放开之后**新**请求才正常走（已经挂住的那些不影响，正好用来验证「重新加载」）。
let hold = true
let held = 0
await page.route(STREAM, async (route) => {
  if (hold) {
    held += 1
    return // 什么都不做 = 请求一直挂着，浏览器永远等不到字节
  }
  await route.continue()
})

await page.goto(BASE + '/videomind/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.evaluate(() => {
  for (const r of document.querySelectorAll(
    '[data-panel="left"] [data-folder-row][data-expanded="false"]',
  )) {
    r.click()
  }
})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-panel="left"] div.cursor-pointer')].filter(
    (x) => !x.hasAttribute('data-folder-row'),
  )
  const r = rows.find((x) => x.textContent.includes('锹农炮虫')) ?? rows[0]
  if (r) r.click()
})
await page.waitForTimeout(2500)

// ================= A. 卡住时的样子 =================
console.log('\n[A] 流被掐住时的画面')
const s1 = await state()
console.log(`  info 被挂起的流请求 ${held} 个`)
check('确实停在「加载视频中」', s1.loading, JSON.stringify(s1))
check('此时没有播放按钮（旧行为：只能退出）', !s1.playBtn)

// ================= B. 看门狗接管 =================
console.log('\n[B] 超时兜底')
// 看门狗 9s；这里等到 12s 保险
await page.waitForTimeout(12000)
const s2 = await state()
check('换成「视频加载超时」提示', s2.timeout, JSON.stringify(s2))
check('给出「重新加载」按钮', s2.retryBtn)
check('不再是死等的「加载视频中」', !s2.loading)

// ================= C. 重新加载能救回来 =================
console.log('\n[C] 重新加载')
// 先放开闸门，再点重试：这样重试发出的新请求能真正走通
hold = false
await page.getByRole('button', { name: '重新加载' }).first().click()
// 流放开了，metadata 应该很快到
await page.waitForFunction(
  () => {
    const v = document.querySelector('video')
    return !!v && v.readyState >= 1
  },
  null,
  { timeout: 20000 },
).catch(() => {})
await page.waitForTimeout(1200)
const s3 = await state()
check('重新加载后 metadata 就绪', s3.readyState >= 1, `readyState=${s3.readyState}`)
check('播放按钮回来了', s3.playBtn)
check('超时提示消失', !s3.timeout)

check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await page.screenshot({ path: 'J:/AIProject/RealVideoWebSite/.probe/player-load-retry.png' })
await page.close()
console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
