import { expect, test } from '@playwright/test'
import { createScriptViaUI, SAMPLE_SCRIPT } from './helpers'

test('默记：后半截遮字 → 点方块单露/整句全露 → 统计 → 连续两次进重点 → 只练清单', async ({ page }) => {
  const id = await createScriptViaUI(page, '默记E2E', SAMPLE_SCRIPT)

  // 进默记页
  await page.goto(`/recite/${id}`)
  await page.getByTestId('recite-segment').selectOption({ index: 1 }) // 第一段（4 句）
  await page.getByTestId('recite-mode-tail').click()
  await page.getByTestId('recite-duration').selectOption('0') // 不限时，避免倒计时干扰
  await page.getByTestId('recite-start').click()
  await expect(page.getByTestId('recite-practice')).toBeVisible()

  // 第一句「杨延辉坐宫院自思自叹」10 字，后半截 5 个方块
  const blocks1 = page.getByTestId('recite-block')
  await expect(blocks1).toHaveCount(5)
  await expect(page.getByTestId('recite-progress')).toContainText('第 1 / 4 句')

  // 点一个方块 → 该方块变成露出来的字（且标红）
  await blocks1.first().click()
  await expect(page.locator('.recite-char.revealed')).toHaveCount(1)
  await expect(page.getByTestId('recite-peek-state')).toContainText('已看 1 个字')

  // 整句露出 → 方块全部消失
  await page.getByTestId('recite-reveal-all').click()
  await expect(blocks1).toHaveCount(0)
  await page.getByTestId('recite-next').click()

  // 第二句不点任何方块，直接下一句（全对）
  await expect(page.getByTestId('recite-progress')).toContainText('第 2 / 4 句')
  await page.getByTestId('recite-next').click()

  // 第三句点一个方块（peeked），第四句全对，快速走完
  await expect(page.getByTestId('recite-progress')).toContainText('第 3 / 4 句')
  await page.getByTestId('recite-block').first().click()
  await page.getByTestId('recite-next').click()
  await expect(page.getByTestId('recite-progress')).toContainText('第 4 / 4 句')
  await page.getByTestId('recite-next').click()

  // 报告：1 perfect（句2）+ 2 peeked（句1、3）+ 1 perfect（句4）= perfect 3, peeked 1
  // 注意句1 是整句露出=peeked
  await expect(page.getByTestId('recite-report')).toBeVisible()
  const reportLines = page.getByTestId('recite-report-line')
  await expect(reportLines).toHaveCount(4)
  await expect(reportLines.filter({ hasText: '杨延辉坐宫院' })).toHaveAttribute('data-status', 'peeked')
  await expect(reportLines.filter({ hasText: '想起了当年事' })).toHaveAttribute('data-status', 'perfect')
  await expect(page.locator('.recite-stat.perfect')).toContainText('3')
  await expect(page.locator('.recite-stat.peeked')).toContainText('1')

  // 第一轮还没有句子进重点（每句最多卡 1 次）
  await expect(page.locator('.recite-stat.focus')).toContainText('0')

  // 同范围再来一轮
  await page.getByTestId('recite-again').click()
  await expect(page.getByTestId('recite-practice')).toBeVisible()
  // 第一句再 peeked 一次（已连着两次）
  await page.getByTestId('recite-block').first().click()
  await page.getByTestId('recite-next').click()
  // 第二句 perfect
  await page.getByTestId('recite-next').click()
  // 第三句再 peeked
  await page.getByTestId('recite-block').first().click()
  await page.getByTestId('recite-next').click()
  // 第四句 perfect 完成
  await page.getByTestId('recite-next').click()

  // 句1、句3 连着两次 peeked → 新进重点 2 句
  await expect(page.locator('.recite-stat.focus b')).toHaveText('2')
  const flagged = page.locator('.recite-report-line[data-new-focus]')
  await expect(flagged).toHaveCount(2)

  // 留下重点清单并结束
  await page.getByTestId('recite-finish-keep').click()
  await expect(page.getByTestId('recite-focus-panel')).toBeVisible()
  await expect(page.getByTestId('recite-focus-item')).toHaveCount(2)

  // 刷新后重点清单仍在
  await page.reload()
  await expect(page.getByTestId('recite-focus-item')).toHaveCount(2)

  // 只练重点清单：全剧范围内勾上后只剩 2 句
  await page.getByTestId('recite-focus-only').check()
  await page.getByTestId('recite-mode-tail').click()
  await page.getByTestId('recite-duration').selectOption('0')
  await expect(page.getByTestId('recite-start')).toBeEnabled()
  await page.getByTestId('recite-start').click()
  await expect(page.getByTestId('recite-progress')).toContainText('/ 2 句')
})

test('默记：按比例遮字方块数 ≈ 字数×比例，且只遮汉字不遮标点', async ({ page }) => {
  const id = await createScriptViaUI(page, '默记比例', SAMPLE_SCRIPT)
  await page.goto(`/recite/${id}`)
  await page.getByTestId('recite-mode-ratio').click()
  await page.getByTestId('recite-duration').selectOption('0')
  await page.getByTestId('recite-start').click()

  // 第一句 10 个汉字，50% → 5 个方块
  await expect(page.getByTestId('recite-block')).toHaveCount(5)

  // 标点始终明文显示（第二句有逗号/感叹号）
  await page.getByTestId('recite-next').click()
  await expect(page.locator('.recite-char.plain', { hasText: '，' })).toHaveCount(1)
})

test('默记：中途退出保留进度，刷新后从下一句接着练；不保留则回滚重点', async ({ page }) => {
  const id = await createScriptViaUI(page, '默记续练', SAMPLE_SCRIPT)
  await page.goto(`/recite/${id}`)
  await page.getByTestId('recite-mode-tail').click()
  await page.getByTestId('recite-duration').selectOption('0')
  await page.getByTestId('recite-start').click()

  // 第一句 peeked 后退出并保留
  await page.getByTestId('recite-block').first().click()
  await page.getByTestId('recite-next').click()
  await expect(page.getByTestId('recite-progress')).toContainText('第 2 / 4 句')
  await page.getByTestId('recite-exit').click()
  await page.getByTestId('recite-exit-keep').click()

  // 回到配置页：出现续练卡片，进度 1/4
  await expect(page.getByTestId('recite-resume')).toBeVisible()
  await expect(page.getByTestId('recite-resume')).toContainText('进度 1/4')

  // 刷新页面，续练卡片仍在
  await page.reload()
  await expect(page.getByTestId('recite-resume')).toBeVisible()
  await page.getByTestId('recite-resume').click()
  // 接着第 2 句
  await expect(page.getByTestId('recite-progress')).toContainText('第 2 / 4 句')
  // 第一句的判定还在：走完后报告里句1 是 peeked
  await page.getByTestId('recite-next').click()
  await page.getByTestId('recite-next').click()
  await page.getByTestId('recite-next').click()
  await expect(page.getByTestId('recite-report')).toBeVisible()
  await expect(page.getByTestId('recite-report-line').first()).toHaveAttribute('data-status', 'peeked')
})

test('默记：原文在练习中不被修改', async ({ page }) => {
  const id = await createScriptViaUI(page, '默记不改原文', SAMPLE_SCRIPT)
  await page.goto(`/recite/${id}`)
  await page.getByTestId('recite-mode-ratio').click()
  await page.getByTestId('recite-duration').selectOption('0')
  await page.getByTestId('recite-start').click()
  await page.getByTestId('recite-block').first().click()
  await page.getByTestId('recite-reveal-all').click()

  // 回编辑页，原文完好
  await page.goto(`/script/${id}`)
  const firstInput = page.locator('[data-testid=line-text]').first()
  await expect(firstInput).toHaveValue('杨延辉坐宫院自思自叹')
})
