import { describe, expect, it } from 'vitest'
import {
  applyFocus,
  buildLineOrder,
  initLineState,
  isMaskable,
  judgeLine,
  makeLineMask,
  makeRng,
  summarizeLines,
  tally,
} from '../../src/engine/memorize'
import type { Line, Segment } from '../../src/types'

function lines(...texts: string[]): Line[] {
  return texts.map((text, i) => ({ id: `l${i + 1}`, text, cues: [], marks: [] }))
}

describe('isMaskable：汉字遮，标点不遮', () => {
  it('汉字、字母、数字可遮；标点空白不遮', () => {
    expect('杨延辉坐宫院'.split('').every(isMaskable)).toBe(true)
    expect(isMaskable('，')).toBe(false)
    expect(isMaskable('。')).toBe(false)
    expect(isMaskable(' ')).toBe(false)
    expect(isMaskable('—')).toBe(false)
    expect(isMaskable('A')).toBe(true)
    expect(isMaskable('3')).toBe(true)
  })
})

describe('makeLineMask 三种模式', () => {
  it('ratio：按比例遮，标点永远不遮；同 seed 可复现', () => {
    const rng1 = makeRng(42)
    const rng2 = makeRng(42)
    const text = '杨延辉坐宫院，自思自叹。'
    const a = makeLineMask(text, 'ratio', 0.5, rng1)
    const b = makeLineMask(text, 'ratio', 0.5, rng2)
    expect(a).toEqual(b)
    // 两个标点位置永远不遮
    expect(a[6]).toBe(false)
    expect(a[11]).toBe(false)
    // 50% 比例下 10 个可遮字应遮住一部分但不是全部
    const maskedCount = a.filter(Boolean).length
    expect(maskedCount).toBeGreaterThan(0)
    expect(maskedCount).toBeLessThan(10)
  })

  it('ratio=1 全遮可遮字；ratio=0 一个不遮', () => {
    const text = '想起了当年事'
    const all = makeLineMask(text, 'ratio', 1, makeRng(1))
    expect(all.every(Boolean)).toBe(true)
    const none = makeLineMask(text, 'ratio', 0, makeRng(1))
    expect(none.some(Boolean)).toBe(false)
  })

  it('tail：只遮后半截', () => {
    const m = makeLineMask('一二三四五六', 'tail', 0.5, makeRng(1))
    expect(m.slice(0, 3)).toEqual([false, false, false])
    expect(m.slice(3)).toEqual([true, true, true])
  })

  it('tail：奇数句后半截多遮一个字', () => {
    const m = makeLineMask('一二三四五', 'tail', 0.5, makeRng(1))
    expect(m.filter(Boolean).length).toBe(3)
    expect(m.slice(0, 2)).toEqual([false, false])
  })

  it('random：整句要么全遮要么不遮，由比例决定概率', () => {
    let sawFull = false
    let sawNone = false
    for (let seed = 1; seed < 200; seed++) {
      const m = makeLineMask('唱词一句四个字', 'random', 0.5, makeRng(seed))
      const n = m.filter(Boolean).length
      expect(n === 0 || n === 7).toBe(true)
      if (n === 7) sawFull = true
      else sawNone = true
    }
    expect(sawFull && sawNone).toBe(true)
  })

  it('没有可遮字的纯标点句返回全 false', () => {
    const m = makeLineMask('—— ，。！', 'ratio', 1, makeRng(1))
    expect(m.some(Boolean)).toBe(false)
  })
})

describe('judgeLine：perfect / peeked / failed', () => {
  it('一个没露直接过 → perfect', () => {
    const st = initLineState([true, true, false])
    expect(judgeLine(st)).toBe('perfect')
  })

  it('露了几个字才过 → peeked', () => {
    const st = initLineState([true, true, false])
    st.masked[0] = false
    expect(judgeLine(st)).toBe('peeked')
  })

  it('整句全露 → failed', () => {
    const st = initLineState([true, true])
    st.masked = [false, false]
    st.fullRevealed = true
    expect(judgeLine(st)).toBe('failed')
  })

  it('本来就没遮字的句子 → perfect', () => {
    expect(judgeLine(initLineState([]))).toBe('perfect')
  })
})

describe('buildLineOrder：范围 + 重点清单', () => {
  const ls = lines('A', 'B', 'C', 'D')
  const segs: Segment[] = [
    { id: 's1', title: '段一', lineIds: ['l1', 'l2'] },
    { id: 's2', title: '段二', lineIds: ['l3', 'l4'] },
  ]

  it('按段落顺序展开', () => {
    const order = buildLineOrder(ls, segs, ['s1', 's2'], new Set(), false)
    expect(order.map((l) => l.id)).toEqual(['l1', 'l2', 'l3', 'l4'])
  })

  it('只选第二段', () => {
    const order = buildLineOrder(ls, segs, ['s2'], new Set(), false)
    expect(order.map((l) => l.id)).toEqual(['l3', 'l4'])
  })

  it('focusOnly 与重点清单取交集', () => {
    const order = buildLineOrder(ls, segs, ['s1', 's2'], new Set(['l2', 'l4']), true)
    expect(order.map((l) => l.id)).toEqual(['l2', 'l4'])
  })
})

describe('applyFocus：连错两次进重点清单', () => {
  const order = [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }]

  /** 构造某结果的摘要 */
  function sum(result: Record<string, 'perfect' | 'peeked' | 'failed'>) {
    return Object.entries(result).map(([lineId, r], i) => ({
      lineId,
      index: i,
      result: r,
      revealed: r === 'perfect' ? 0 : 1,
      maskCount: 2,
    }))
  }

  it('第一次没记住不进清单（streak=1）', () => {
    const u = applyFocus([], {}, sum({ l1: 'failed' }), true)
    expect(u.focus).toEqual([])
    expect(u.streaks.l1).toBe(1)
  })

  it('连着两次没记住自动进清单', () => {
    const u1 = applyFocus([], {}, sum({ l1: 'failed' }), true)
    const u2 = applyFocus(u1.focus, u1.streaks, sum({ l1: 'failed' }), true)
    expect(u2.focus).toEqual(['l1'])
    expect(u2.added).toEqual(['l1'])
  })

  it('没记住 → 一次没错：streak 清零，不再累计', () => {
    const u1 = applyFocus([], {}, sum({ l1: 'failed' }), true)
    const u2 = applyFocus(u1.focus, u1.streaks, sum({ l1: 'perfect' }), true)
    expect(u2.streaks.l1).toBe(0)
    expect(u2.focus).toEqual([])
  })

  it('看了一眼不清零 streak', () => {
    const u1 = applyFocus([], {}, sum({ l1: 'failed' }), true)
    const u2 = applyFocus(u1.focus, u1.streaks, sum({ l1: 'peeked' }), true)
    expect(u2.streaks.l1).toBe(1)
  })

  it('已在清单中练到一次没错 → 毕业移出', () => {
    const u = applyFocus(['l1'], { l1: 2 }, sum({ l1: 'perfect' }), true)
    expect(u.focus).toEqual([])
    expect(u.removed).toEqual(['l1'])
  })

  it('选「不保留」：本次新增撤销，但 streak 仍记录；毕业不撤销', () => {
    const u = applyFocus(['l2'], { l1: 1, l2: 2 }, sum({ l1: 'failed', l2: 'perfect' }), false)
    expect(u.focus).toEqual([]) // l1 新增撤销，l2 已毕业不撤销
    expect(u.added).toEqual([])
    expect(u.removed).toEqual(['l2'])
    expect(u.streaks.l1).toBe(2) // 下次再错一次即可再进
  })

  it('tally 统计三类数量', () => {
    const states: Record<string, ReturnType<typeof initLineState>> = {}
    const a = initLineState([true]) // 没看 → perfect
    const b = initLineState([true])
    b.masked[0] = false // peeked
    const c = initLineState([true])
    c.masked = [false]
    c.fullRevealed = true // failed
    states.l1 = a
    states.l2 = b
    states.l3 = c
    const s = summarizeLines(order, states)
    const t = tally(s)
    expect(t).toEqual({ total: 4, perfect: 2, peeked: 1, failed: 1 })
  })
})
