import { describe, expect, it } from 'vitest'
import * as repo from '../../src/storage/repo'
import type { Script } from '../../src/types'

function makeScript(over: Partial<Script> = {}): Script {
  return {
    id: `sc_${Math.random().toString(36).slice(2, 8)}`,
    title: '测试剧目',
    lines: [
      { id: 'l1', text: '第一句', cues: [], marks: [] },
      { id: 'l2', role: '旦', text: '第二句', cues: [], marks: ['hard'], note: '轻一点' },
    ],
    segments: [{ id: 's1', title: '第一段', lineIds: ['l1', 'l2'] }],
    style: 'opera',
    updatedAt: Date.now(),
    ...over,
  }
}

describe('IndexedDB 仓库（全部数据本地，不上传）', () => {
  it('剧本 CRUD 往返', async () => {
    const s = makeScript()
    await repo.saveScript(s)
    const got = await repo.getScript(s.id)
    expect(got?.title).toBe('测试剧目')
    expect(got?.lines[1].marks).toEqual(['hard'])

    const list = await repo.listScripts()
    expect(list.some((x) => x.id === s.id)).toBe(true)

    await repo.deleteScript(s.id)
    expect(await repo.getScript(s.id)).toBeUndefined()
  })

  it('设置合并默认值并保存', async () => {
    const s0 = await repo.loadSettings()
    expect(s0.theme).toBe('dark')
    expect(s0.autoFit).toBe(true)
    await repo.saveSettings({ ...s0, speedPxPerSec: 123, theme: 'highContrast' })
    const s1 = await repo.loadSettings()
    expect(s1.speedPxPerSec).toBe(123)
    expect(s1.theme).toBe('highContrast')
    expect(s1.holdOnCue).toBe(true)
  })

  it('练习次数累加（本条已练 N 次）', async () => {
    const id = 'script-practice-1'
    const c1 = await repo.bumpPractice(id, ['l1', 'l2'])
    const c2 = await repo.bumpPractice(id, ['l1'])
    expect(c2.l1).toBe(2)
    expect(c2.l2).toBe(1)
    expect(c1).toBeDefined()
  })

  it('默记记录：默认空记录 → 保存往返（重点清单 + 会话）', async () => {
    const id = 'script-memo-1'
    const empty = await repo.getMemorize(id)
    expect(empty.focus).toEqual([])
    expect(empty.streaks).toEqual({})
    expect(empty.session).toBeUndefined()
    expect(empty.history).toEqual([])

    await repo.saveMemorize({
      ...empty,
      focus: ['l1', 'l2'],
      streaks: { l1: 2 },
      session: {
        startedAt: 123,
        settings: { ratio: 0.5, mode: 'ratio', durationMin: 10, segmentIds: ['s1'], focusOnly: false },
        order: ['l1', 'l2'],
        cursor: 1,
        seed: 99,
        states: { l1: { masked: [false], everMasked: [true], fullRevealed: false, result: 'peeked' } },
      },
    })
    const got = await repo.getMemorize(id)
    expect(got.focus).toEqual(['l1', 'l2'])
    expect(got.session?.cursor).toBe(1)
    expect(got.session?.states.l1.result).toBe('peeked')
  })

  it('pruneMemorize：删除已不存在的句子并夹紧 cursor', async () => {
    const id = 'script-memo-2'
    await repo.saveMemorize({
      id,
      focus: ['gone', 'keep'],
      streaks: { gone: 2, keep: 1 },
      history: [],
      session: {
        startedAt: 1,
        settings: { ratio: 0.5, mode: 'tail', durationMin: 0, segmentIds: ['s'], focusOnly: false },
        order: ['gone', 'keep'],
        cursor: 1,
        seed: 7,
        states: { gone: { masked: [], everMasked: [], fullRevealed: false }, keep: { masked: [true], everMasked: [true], fullRevealed: false } },
      },
      updatedAt: 0,
    })
    const pruned = await repo.pruneMemorize(id, new Set(['keep']))
    expect(pruned.focus).toEqual(['keep'])
    expect(pruned.streaks).toEqual({ keep: 1 })
    expect(pruned.session?.order).toEqual(['keep'])
    expect(pruned.session?.cursor).toBe(0)
  })

  it('pruneMemorize：全部句子已提交结果（练完未选择就关页）→ 清除会话', async () => {
    const id = 'script-memo-3'
    await repo.saveMemorize({
      id,
      focus: [],
      streaks: {},
      history: [],
      session: {
        startedAt: 1,
        settings: { ratio: 0.5, mode: 'ratio', durationMin: 0, segmentIds: ['s'], focusOnly: false },
        order: ['keep1', 'keep2'],
        cursor: 2,
        seed: 7,
        states: {
          keep1: { masked: [false], everMasked: [true], fullRevealed: false, result: 'perfect' },
          keep2: { masked: [false, false], everMasked: [true, true], fullRevealed: true, result: 'failed' },
        },
      },
      updatedAt: 0,
    })
    const pruned = await repo.pruneMemorize(id, new Set(['keep1', 'keep2']))
    expect(pruned.session).toBeUndefined()
  })

  it('模板保存与实例化', async () => {    const s = makeScript({ title: '文昭关' })
    const tpl = await repo.saveAsTemplate(s)
    expect(tpl.title).toBe('模板·文昭关')
    const inst = repo.newScriptFrom(tpl)
    expect(inst.id).not.toBe(tpl.id)
    expect(inst.title).toBe('文昭关')
    await repo.deleteTemplate(tpl.id)
  })
})
