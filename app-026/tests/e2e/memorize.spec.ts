import { expect, test } from '@playwright/test'
import { createScriptViaUI } from './helpers'

/**
 * 默记练习完整旅程：
 * 遮字 → 单字露出 → 整句全露 → 下一句 → 统计 → 连错两次进重点清单 → 只练清单 → 毕业
 */
test.describe('默记练习', () => {
  test('遮字、露字、统计、重点清单流转', async ({ page }) => {
    await page.goto('/')
    const id = await createScriptViaUI(page, '默记E2E', '生：甲乙丙丁\n生：子丑寅卯\n\n旦：一二三四')

    // 进入默记设置页
    await page.goto(`/memorize/${id}`)
    await page.getByTestId('memo-start').waitFor()
    expect(await page.getByTestId('memo-seg').count()).toBe(2)
    expect(await page.getByTestId('memo-focus-only').isDisabled()).toBeTruthy()

    // 全遮，避免随机抽不到；开始
    await page.getByTestId('memo-ratio').fill('100')
    await page.getByTestId('memo-duration').selectOption('0')
    await page.getByTestId('memo-start').click()

    // 第一句：露出单字 → 整句全露 → 下一句（failed）
    await page.getByTestId('memo-cell').first().waitFor()
    await page.getByTestId('memo-card').waitFor()
    expect(await page.getByTestId('memo-cell').count()).toBe(4)
    await page.getByTestId('memo-cell').first().click()
    expect(await page.getByTestId('memo-cell').count()).toBe(3)
    await page.getByTestId('memo-reveal-all').click()
    expect(await page.getByTestId('memo-cell').count()).toBe(0)
    await expect(page.getByTestId('memo-card')).toHaveAttribute('data-full', 'true')
    await page.getByTestId('memo-next').click()

    // 第二句：直接下一句（perfect，一个没看）
    await expect(page.getByTestId('memo-progress')).toContainText('第 2 / 3 句')
    expect(await page.getByTestId('memo-cell').count()).toBe(4)
    await page.getByTestId('memo-next').click()

    // 第三句：整句全露（failed）
    await expect(page.getByTestId('memo-progress')).toContainText('第 3 / 3 句')
    await page.getByTestId('memo-reveal-all').click()
    await page.getByTestId('memo-next').click()

    // 统计页：2 没记住 / 1 一次没错
    await page.getByTestId('memo-stats').waitFor()
    expect(await page.getByTestId('memo-total-failed').textContent()).toContain('2')
    expect(await page.getByTestId('memo-total-perfect').textContent()).toContain('1')
    expect(await page.getByTestId('memo-result-item').all()).toHaveLength(3)

    await page.getByTestId('memo-keep').click()
    await page.getByTestId('memo-again').click()

    // 第二轮：全遮开始，三句全部整句全露（streak → 2，进重点清单）
    await page.getByTestId('memo-start').waitFor()
    await page.getByTestId('memo-ratio').fill('100')
    await page.getByTestId('memo-start').click()
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('memo-reveal-all').click()
      await page.getByTestId('memo-next').click()
    }
    await page.getByTestId('memo-stats').waitFor()
    await expect(page.getByTestId('memo-stats')).toContainText('新增重点')
    await page.getByTestId('memo-keep').click()
    await page.getByTestId('memo-again').click()

    // 第三轮：「只练重点清单」可用，里面有两句（第三句上轮 perfect？不——上轮三句全 failed；
    // 第一轮第二句是 perfect，故它 streak=0 不在清单）
    await page.getByTestId('memo-focus-only').waitFor()
    expect(await page.getByTestId('memo-focus-only').isDisabled()).toBeFalsy()
    await page.getByTestId('memo-focus-only').check()
    await page.getByTestId('memo-start').click()

    // 重点共 2 句
    await page.getByTestId('memo-cell').first().waitFor()
    await expect(page.getByTestId('memo-progress')).toContainText('/ 2 句')

    // 第一句直接过（perfect）→ 毕业；第二句整句全露 → 留在清单
    await page.getByTestId('memo-next').click()
    await page.getByTestId('memo-reveal-all').click()
    await page.getByTestId('memo-next').click()

    await page.getByTestId('memo-stats').waitFor()
    await expect(page.getByTestId('memo-stats')).toContainText('重点毕业')
    await page.getByTestId('memo-keep').click()
    await page.getByTestId('memo-back').click()
    await page.waitForURL(/\/script\//)
  })

  test('中途退出再进来接着练', async ({ page }) => {
    await page.goto('/')
    const id = await createScriptViaUI(page, '默记续练', '生：甲乙丙丁\n生：子丑寅卯')

    await page.goto(`/memorize/${id}`)
    await page.getByTestId('memo-ratio').fill('100')
    await page.getByTestId('memo-start').click()

    // 第一句露一个字后退出
    await page.getByTestId('memo-cell').first().click()
    await page.getByTestId('memo-exit').click()
    await page.getByTestId('memo-exit-save').click()
    await page.waitForURL(/\/script\//)

    // 再进设置页出现续练卡片
    await page.goto(`/memorize/${id}`)
    await page.getByTestId('memo-resume').waitFor()
    await expect(page.getByTestId('memo-resume')).toContainText('从第 1 句接着练')
    await page.getByTestId('memo-resume-btn').click()

    // 露出状态保留（4 个字已露 1 个 → 剩 3 个方块）
    await page.getByTestId('memo-card').waitFor()
    expect(await page.getByTestId('memo-cell').count()).toBe(3)
    // 这一句提交时应算 peeked
    await page.getByTestId('memo-next').click()
    await page.getByTestId('memo-next').click() // 第二句直接过
    await page.getByTestId('memo-stats').waitFor()
    expect(await page.getByTestId('memo-total-peeked').textContent()).toContain('1')
  })

  test('只遮后半截模式：每句前半可见后半是方块', async ({ page }) => {
    await page.goto('/')
    const id = await createScriptViaUI(page, '默记后半截', '生：甲乙丙丁戊己')
    await page.goto(`/memorize/${id}`)
    await page.getByTestId('memo-mode-tail').click()
    await page.getByTestId('memo-start').click()
    await page.getByTestId('memo-card').waitFor()
    // 6 个字遮后半 3 个
    expect(await page.getByTestId('memo-cell').count()).toBe(3)
  })
})
