/**
 * 默记页面的 React 冒烟测试（e2e 在无浏览器依赖的环境跑不了，这里用 jsdom 兜住交互主链路）。
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as repo from '../../src/storage/repo'
import type { Script } from '../../src/types'
import { Recite } from '../../src/pages/Recite'

const SCRIPT: Script = {
  id: 'sc-render',
  title: '渲染剧目',
  lines: [
    { id: 'l1', role: '生', text: '杨延辉坐宫院自思自叹', cues: [], marks: [] },
    { id: 'l2', role: '生', text: '想起了当年事好不惨然', cues: [], marks: [] },
  ],
  segments: [{ id: 's1', title: '第一段', lineIds: ['l1', 'l2'] }],
  style: 'opera',
  updatedAt: 1,
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

beforeEach(async () => {
  await repo.saveScript(SCRIPT)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await repo.deleteScript(SCRIPT.id)
})

function $<T extends Element>(sel: string): T {
  const el = host.querySelector(sel)
  if (!el) throw new Error(`not found: ${sel}`)
  return el as T
}

async function renderSetup() {
  await act(async () => root.render(<Recite id={SCRIPT.id} />))
  await flushMicrotasks()
  if (!host.querySelector('[data-testid=recite-start]')) throw new Error('setup did not load')
}

function click(sel: string) {
  act(() => ($(sel) as HTMLButtonElement).click())
}
async function clickAsync(sel: string) {
  await act(async () => ($(sel) as HTMLButtonElement).click())
}
function selectValue(sel: string, value: string) {
  act(() => {
    const el = $(sel) as HTMLSelectElement
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('<Recite /> 冒烟：配置 → 练习 → 报告 → 重点清单', () => {
  it('配置页渲染唱段与重点空态', async () => {
    await renderSetup()
    expect(host.textContent).toContain('默记练习')
    expect(host.textContent).toContain('第一段')
    expect($('[data-testid=recite-focus-empty]').textContent).toContain('连着两次')
    expect(($('[data-testid=recite-start]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('后半截练习：10 字句出 5 个方块，点一个露一个，全对/看过统计正确', async () => {
    await renderSetup()
    // 后半截 + 不限时，开始
    click('[data-testid=recite-mode-tail]')
    selectValue('[data-testid=recite-duration]', '0')
    await clickAsync('[data-testid=recite-start]')

    // 第一句：5 个方块
    expect(host.querySelectorAll('[data-testid=recite-block]').length).toBe(5)
    // 点第一个方块 → 露 1 个红字
    click('[data-testid=recite-block]')
    expect(host.querySelectorAll('.recite-char.revealed').length).toBe(1)
    // 下一句（句1 记 peeked）
    await clickAsync('[data-testid=recite-next]')

    // 第二句直接下一句（perfect）
    await clickAsync('[data-testid=recite-next]')

    // 报告
    expect($('[data-testid=recite-report]')).toBeTruthy()
    expect(host.querySelector('.recite-stat.perfect b')?.textContent).toBe('1')
    expect(host.querySelector('.recite-stat.peeked b')?.textContent).toBe('1')
    const statuses = [...host.querySelectorAll('[data-testid=recite-report-line]')].map((el) =>
      el.getAttribute('data-status'),
    )
    expect(statuses).toEqual(['peeked', 'perfect'])

    // 留下重点清单（本轮最多卡 1 次，没有新进）
    await clickAsync('[data-testid=recite-finish-keep]')
    expect($('[data-testid=recite-focus-empty]')).toBeTruthy()
  })

  it('连着两轮 peeked 同一句 → 自动进重点清单；勾选只练清单后范围只剩 1 句', async () => {
    await renderSetup()
    click('[data-testid=recite-mode-tail]')
    selectValue('[data-testid=recite-duration]', '0')

    // 两轮：每轮第一句点方块（peeked），第二句直接过；两轮之间用「再来一轮」衔接
    await clickAsync('[data-testid=recite-start]')
    for (let round = 0; round < 2; round++) {
      click('[data-testid=recite-block]')
      await clickAsync('[data-testid=recite-next]')
      await clickAsync('[data-testid=recite-next]')
      if (round === 0) await clickAsync('[data-testid=recite-again]')
    }
    expect(host.querySelector('.recite-stat.focus b')?.textContent).toBe('1')
    await clickAsync('[data-testid=recite-finish-keep]')
    expect(host.querySelectorAll('[data-testid=recite-focus-item]').length).toBe(1)

    // 只练重点清单：开始后进度为 / 1 句
    click('[data-testid=recite-focus-only]')
    await clickAsync('[data-testid=recite-start]')
    expect($('[data-testid=recite-progress]').textContent).toContain('/ 1 句')
  })
})
