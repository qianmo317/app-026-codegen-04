import { describe, expect, it } from 'vitest'
import {
  applyJudgement,
  buildLineMask,
  buildSessionLines,
  createSessionLines,
  hashSeed,
  isMaskable,
  judgeLine,
  reconcileSession,
  revealAll,
  revealOne,
  rollbackFocus,
  selectLineIds,
  summarize,
  updateStreaks,
} from '../../src/engine/recite'
import type { ReciteSession, Script } from '../../src/types'

function makeScript(): Script {
  return {
    id: 'sc1',
    title: '测试',
    lines: [
      { id: 'l1', role: '生', text: '杨延辉坐宫院自思自叹', cues: [], marks: [] },
      { id: 'l2', role: '生', text: '想起了当年事，好不惨然！', cues: [], marks: [] },
      { id: 'l3', role: '旦', text: '夫妻们打坐在皇宫院', cues: [], marks: [] },
      { id: 'l4', text: '—— 过门 ——', cues: [{ id: 'c1', kind: 'interlude', seconds: 4 }], marks: [] },
    ],
    segments: [
      { id: 's1', title: '第一段', lineIds: ['l1', 'l2'] },
      { id: 's2', title: '第二段', lineIds: ['l3', 'l4'] },
    ],
    style: 'opera',
    updatedAt: 1,
  }
}

describe('默记：可遮字识别', () => {
  it('汉字/假名/谚文可遮，标点数字字母不遮', () => {
    expect('杨延辉'.split('').every(isMaskable)).toBe(true)
    expect(isMaskable('あ')).toBe(true)
    expect(isMaskable('한')).toBe(true)
    expect(['，', '！', '—', ' ', 'a', '1', '：'].some(isMaskable)).toBe(false)
  })

  it('相同种子哈希确定', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'))
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'))
  })
})

describe('默记：遮字方案', () => {
  it('ratio：按比例随机遮，标点不在数组里，且同种子结果确定', () => {
    const text = '想起了当年事，好不惨然！' // 10 个汉字
    const a = buildLineMask(text, { mode: 'ratio', ratio: 0.5, seed: 'seed-1' }, 'l2', true)
    const b = buildLineMask(text, { mode: 'ratio', ratio: 0.5, seed: 'seed-1' }, 'l2', true)
    expect(a).toEqual(b)
    expect(a).toHaveLength(10)
    const count = a.filter(Boolean).length
    expect(count).toBe(Math.round(10 * 0.5))
    // 换种子换排布
    const c = buildLineMask(text, { mode: 'ratio', ratio: 0.5, seed: 'seed-2' }, 'l2', true)
    expect(c).not.toEqual(a)
  })

  it('ratio=1 全遮、ratio=0 不遮', () => {
    const text = '夫妻们打坐在皇宫院'
    expect(buildLineMask(text, { mode: 'ratio', ratio: 1, seed: 's' }, 'x', true).every(Boolean)).toBe(true)
    expect(buildLineMask(text, { mode: 'ratio', ratio: 0, seed: 's' }, 'x', true).some(Boolean)).toBe(false)
  })

  it('tail：只遮后半截（奇数句后半截多一个）', () => {
    expect(buildLineMask('一二三四', { mode: 'tail', ratio: 0.5, seed: 's' }, 'x', true)).toEqual([false, false, true, true])
    expect(buildLineMask('一二三四五', { mode: 'tail', ratio: 0.5, seed: 's' }, 'x', true)).toEqual([false, false, true, true, true])
  })

  it('random：整句要么全遮要么全不遮，由 maskAll 决定', () => {
    const text = '杨延辉坐宫院自思自叹'
    expect(buildLineMask(text, { mode: 'random', ratio: 0.5, seed: 's' }, 'x', false).some(Boolean)).toBe(false)
    expect(buildLineMask(text, { mode: 'random', ratio: 0.5, seed: 's' }, 'x', true).every(Boolean)).toBe(true)
  })

  it('无可遮字（纯标点行）→ 空数组', () => {
    expect(buildLineMask('————，！', { mode: 'ratio', ratio: 1, seed: 's' }, 'x', true)).toEqual([])
  })
})

describe('默记：句选择与会话构造', () => {
  it('全剧按段顺序；选段只取该段', () => {
    const s = makeScript()
    expect(selectLineIds(s, null, false, [])).toEqual(['l1', 'l2', 'l3', 'l4'])
    expect(selectLineIds(s, 's2', false, [])).toEqual(['l3', 'l4'])
  })

  it('focusOnly 只保留重点清单里的句且保序', () => {
    const s = makeScript()
    expect(selectLineIds(s, null, true, ['l4', 'l2'])).toEqual(['l2', 'l4'])
    expect(selectLineIds(s, 's1', true, ['l4', 'l2'])).toEqual(['l2'])
  })

  it('createSessionLines 生成的初始状态：全 none、未露', () => {
    const s = makeScript()
    const lines = createSessionLines(s, {
      mode: 'tail', ratio: 0.5, durationMin: 5, focusOnly: false, segmentId: 's1', seed: 'sg', focusIds: [],
    })
    expect(lines.map((l) => l.id)).toEqual(['l1', 'l2'])
    expect(lines.every((l) => l.status === 'none' && l.revealed.length === 0)).toBe(true)
  })

  it('random 模式抽句比例生效（大样本下接近比例）', () => {
    const s: Script = {
      ...makeScript(),
      segments: [{ id: 'all', title: '全', lineIds: Array.from({ length: 200 }, (_, i) => `L${i}`) }],
      lines: Array.from({ length: 200 }, (_, i) => ({ id: `L${i}`, text: '甲乙丙丁', cues: [], marks: [] })),
    }
    const lines = buildSessionLines(s, s.segments[0].lineIds, { mode: 'random', ratio: 0.5, seed: 'rnd' })
    const allMasked = lines.filter((l) => l.masked.every(Boolean)).length
    expect(allMasked).toBeGreaterThan(60)
    expect(allMasked).toBeLessThan(140)
    // 没有「半遮」的句
    expect(lines.every((l) => l.masked.every(Boolean) || l.masked.every((m) => !m))).toBe(true)
  })
})

describe('默记：露字与判句', () => {
  it('点方块露一个字、幂等；点整句全露', () => {
    const s = makeScript()
    const lines = createSessionLines(s, {
      mode: 'ratio', ratio: 1, durationMin: 0, focusOnly: false, segmentId: 's1', seed: 'j1', focusIds: [],
    })
    const l0 = lines[0]
    const once = revealOne(l0, 0)
    expect(once).toEqual([0])
    expect(revealOne({ ...l0, revealed: once }, 0)).toEqual([0]) // 重复点不变
    expect(revealAll({ ...l0, revealed: once })).toHaveLength(l0.masked.length)
  })

  it('一个字没露 → perfect；露过哪怕一个 → peeked；没遮字 → skipped', () => {
    const line = { id: 'l', masked: [true, true], status: 'none' as const, revealed: [] as number[] }
    expect(judgeLine(line)).toBe('perfect')
    expect(judgeLine({ ...line, revealed: [1] })).toBe('peeked')
    // 整句露出后也算 peeked（看了一眼才想起来）
    expect(judgeLine({ ...line, revealed: [0, 1] })).toBe('peeked')
    // random 未抽中 / 纯标点 / 比例算出 0 个
    expect(judgeLine({ id: 'x', masked: [false, false], status: 'none', revealed: [] })).toBe('skipped')
    expect(judgeLine({ id: 'x', masked: [], status: 'none', revealed: [] })).toBe('skipped')
  })

  it('skipped 不影响连续计数（中性）', () => {
    const afterPeek = updateStreaks({}, 'l1', 'peeked')
    expect(afterPeek.l1).toBe(1)
    expect(updateStreaks(afterPeek, 'l1', 'skipped').l1).toBe(1)
    expect(updateStreaks(afterPeek, 'l1', 'perfect').l1).toBe(0)
  })
})

describe('默记：连续计数与重点清单', () => {
  it('连着两次 peeked 自动进清单；perfect 清零', () => {
    let focus: string[] = []
    let streaks: Record<string, number> = {}

    let r = applyJudgement(focus, streaks, 'l1', 'peeked')
    focus = r.focusIds
    streaks = r.streaks
    expect(streaks.l1).toBe(1)
    expect(focus).toEqual([]) // 一次不进
    expect(r.newlyFocused).toBe(false)

    r = applyJudgement(focus, streaks, 'l1', 'peeked')
    focus = r.focusIds
    streaks = r.streaks
    expect(streaks.l1).toBe(2)
    expect(focus).toEqual(['l1']) // 连着两次自动进
    expect(r.newlyFocused).toBe(true)

    // 幂等：第三次也不重复
    r = applyJudgement(focus, streaks, 'l1', 'peeked')
    expect(r.focusIds).toEqual(['l1'])

    // 一次没错 → 清零，且不自动移出清单（要手动「记住了」）
    r = applyJudgement(r.focusIds, r.streaks, 'l1', 'perfect')
    expect(r.streaks.l1).toBe(0)
    expect(r.focusIds).toEqual(['l1'])
  })
})

describe('默记：退出回滚', () => {
  it('「不保留」把本轮新进重点回滚，计数回到 1', () => {
    const rolled = rollbackFocus({ focusIds: ['old', 'new1', 'new2'], streaks: { old: 2, new1: 2, new2: 2 } }, ['old'])
    expect(rolled.focusIds).toEqual(['old'])
    expect(rolled.streaks.new1).toBe(1)
    expect(rolled.streaks.old).toBe(2)
  })
})

describe('默记：统计', () => {
  it('按句汇总 perfect/peeked/未练 + 新进重点', () => {
    const session: ReciteSession = {
      maskMode: 'ratio', ratio: 0.5, durationMin: 0, remainingSec: null,
      lineIds: ['l1', 'l2', 'l3', 'l4'], focusOnly: false,
      lines: [
        { id: 'l1', masked: [true], status: 'perfect', revealed: [] },
        { id: 'l2', masked: [true], status: 'peeked', revealed: [0] },
        { id: 'l3', masked: [false], status: 'skipped', revealed: [] },
        { id: 'l4', masked: [true], status: 'none', revealed: [] },
      ],
      focusSnapshot: [], startedAt: 1,
    }
    const stats = summarize(session, ['l2'], [])
    expect(stats).toMatchObject({ total: 4, practiced: 2, perfect: 1, peeked: 1, skipped: 1 })
    expect(stats.newFocusIds).toEqual(['l2'])
  })
})

describe('默记：续练校正（原文可能已编辑）', () => {
  it('删除的句剔除；遮字数组按新长度裁剪，已露下标越界丢弃', () => {
    const session: ReciteSession = {
      maskMode: 'ratio', ratio: 1, durationMin: 0, remainingSec: null,
      lineIds: ['l1', 'l-gone'], focusOnly: false,
      lines: [
        { id: 'l1', masked: [true, true, true, true, true, true, true, true, true, true], status: 'peeked', revealed: [0, 9] },
        { id: 'l-gone', masked: [true], status: 'perfect', revealed: [] },
      ],
      focusSnapshot: [], startedAt: 1,
    }
    const script = makeScript() // l1 有 10 个汉字，l-gone 不存在
    const fixed = reconcileSession(session, script)
    expect(fixed.lineIds).toEqual(['l1'])
    expect(fixed.lines).toHaveLength(1)
    expect(fixed.lines[0].masked).toHaveLength(10)
    expect(fixed.lines[0].revealed).toEqual([0, 9])
    expect(fixed.lines[0].status).toBe('peeked')
  })

  it('句子加长：遮字数组补 false（续练同一轮不换题）', () => {
    const session: ReciteSession = {
      maskMode: 'ratio', ratio: 1, durationMin: 0, remainingSec: null,
      lineIds: ['l3'], focusOnly: false,
      lines: [{ id: 'l3', masked: [true, true], status: 'none', revealed: [] }],
      focusSnapshot: [], startedAt: 1,
    }
    const script = makeScript() // l3「夫妻们打坐在皇宫院」有 9 个汉字
    const fixed = reconcileSession(session, script)
    expect(fixed.lines[0].masked).toHaveLength(9)
    expect(fixed.lines[0].masked.slice(0, 2)).toEqual([true, true])
    expect(fixed.lines[0].masked.slice(2).some(Boolean)).toBe(false)
  })
})
