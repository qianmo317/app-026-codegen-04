import type { Line, Segment } from '../types'

/**
 * 默记练习纯逻辑层：遮罩生成 / 判定 / 统计 / 重点清单。
 * 不依赖 React 与 IndexedDB，全部函数可确定性测试（随机由 seed 注入）。
 */

export type MaskMode = 'ratio' | 'tail' | 'random'
export type LineResult = 'perfect' | 'peeked' | 'failed'

export interface MemorizeLineState {
  /** 每个可遮字的 mask 状态：true=仍遮住，false=已露出 */
  masked: boolean[]
  /** 每个可遮字是否曾被遮过（重置/重练时保留判定依据） */
  everMasked: boolean[]
  /** 是否点过「整句全露」 */
  fullRevealed: boolean
  /** 已记录的最终结果；未提交为 undefined */
  result?: LineResult
}

export interface MemorizeSettings {
  /** 0~1：按比例遮字时的遮字比例；随机抽句模式下作为抽中句子的概率 */
  ratio: number
  mode: MaskMode
  /** 练习时长（分钟），0 = 不限时 */
  durationMin: number
  segmentIds: string[]
  focusOnly: boolean
}

export interface MemorizeLineSummary {
  lineId: string
  index: number
  result: LineResult
  revealed: number
  maskCount: number
}

/** 进行中的练习会话（持久化，供中途退出后接着练） */
export interface MemorizeSession {
  startedAt: number
  settings: MemorizeSettings
  /** 本次练习的句子顺序（line id） */
  order: string[]
  /** 当前练到第几句（0-based） */
  cursor: number
  /** 遮罩布局随机种子（恢复后布局与上次一致） */
  seed: number
  states: Record<string, MemorizeLineState>
}

export interface PracticeHistoryEntry {
  at: number
  mode: MaskMode
  durationMin: number
  focusOnly: boolean
  totals: PracticeTotals
  addedCount: number
}

/* ---------- 字符判定 ---------- */

/** 可遮字符：汉字、字母、数字。标点、空格、空白不遮（保留记忆锚点） */
export function isMaskable(ch: string): boolean {
  return /[\p{Script=Han}\p{L}\p{N}]/u.test(ch)
}

/** mulberry32：短小确定性 PRNG，保证同 seed 遮罩布局可复现（中途退出再进来一致） */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function maskableFlags(text: string): boolean[] {
  return Array.from(text).map(isMaskable)
}

/**
 * 为一句生成遮罩布局。
 * - ratio：可遮字按比例独立随机遮住
 * - tail：只遮后半截——从中间第一个可遮字起遮到句末
 * - random：整句要么全遮（rng < ratio）要么不遮
 */
export function makeLineMask(text: string, mode: MaskMode, ratio: number, rng: () => number): boolean[] {
  const flags = maskableFlags(text)
  const maskableIdx: number[] = []
  flags.forEach((f, i) => {
    if (f) maskableIdx.push(i)
  })
  const masked = new Array(flags.length).fill(false)
  const n = maskableIdx.length
  if (n === 0) return masked

  if (mode === 'tail') {
    const start = Math.floor(n / 2)
    for (let k = start; k < n; k++) masked[maskableIdx[k]] = true
    return masked
  }

  if (mode === 'random') {
    if (rng() < ratio) for (const i of maskableIdx) masked[i] = true
    return masked
  }

  // ratio：逐字独立抽样
  for (const i of maskableIdx) {
    if (rng() < ratio) masked[i] = true
  }
  return masked
}

export function initLineState(masked: boolean[]): MemorizeLineState {
  return { masked: masked.slice(), everMasked: masked.slice(), fullRevealed: false }
}

/* ---------- 练习句子顺序 ---------- */

/** 按段落顺序展开选中的 lineId；focusOnly 时再与重点清单取交集 */
export function buildLineOrder(
  lines: Line[],
  segments: Segment[],
  segmentIds: string[],
  focusIds: Set<string>,
  focusOnly: boolean,
): Line[] {
  const selected = new Set(segmentIds)
  const ordered: Line[] = []
  const byId = new Map(lines.map((l) => [l.id, l]))
  for (const seg of segments) {
    if (!selected.has(seg.id)) continue
    for (const lid of seg.lineIds) {
      const line = byId.get(lid)
      if (!line) continue
      if (focusOnly && !focusIds.has(lid)) continue
      ordered.push(line)
    }
  }
  return ordered
}

/* ---------- 判定 ---------- */

export function judgeLine(st: MemorizeLineState): LineResult {
  if (st.fullRevealed) return 'failed'
  // 曾遮住的字里有没有已经露出来的——露过即算「看了一眼」
  let seen = false
  for (let i = 0; i < st.everMasked.length; i++) {
    if (st.everMasked[i] && !st.masked[i]) {
      seen = true
      break
    }
  }
  return seen ? 'peeked' : 'perfect'
}

/* ---------- 重点清单（连错两次） ---------- */

export interface FocusUpdate {
  focus: string[]
  /** 每个句子当前的连续失败/提示次数（1/2），未在跟踪中的句子无记录 */
  streaks: Record<string, number>
  added: string[]
  removed: string[]
}

/**
 * 根据本次练习的逐句结果推进重点清单：
 * - failed（整句全露）：streak +1，连续两次（≥2）自动进重点清单
 * - perfect：streak 清零；已在清单中的「毕业」移出
 * - peeked（看了几眼才想起）：保持现状（streak 不清零、也不入清单）
 *
 * @param keep 是否保留本次对清单的改动；false 时本次新加入的撤销
 *        （streak 仍记录，下次再错照样能进），毕业的句子不撤销（已掌握的事实）。
 */
export function applyFocus(
  prevFocus: string[],
  prevStreaks: Record<string, number>,
  summaries: MemorizeLineSummary[],
  keep: boolean,
): FocusUpdate {
  const streaks: Record<string, number> = { ...prevStreaks }
  let focus = new Set(prevFocus)
  const added = new Set<string>()
  const removed = new Set<string>()

  for (const s of summaries) {
    if (s.result === 'failed') {
      streaks[s.lineId] = (streaks[s.lineId] ?? 0) + 1
      if (streaks[s.lineId] >= 2 && !focus.has(s.lineId)) {
        focus.add(s.lineId)
        added.add(s.lineId)
      }
    } else if (s.result === 'perfect') {
      streaks[s.lineId] = 0
      if (focus.has(s.lineId)) {
        focus.delete(s.lineId)
        removed.add(s.lineId)
      }
    }
    // peeked：不动
  }

  if (!keep) {
    for (const id of added) focus.delete(id)
    added.clear()
  }

  return {
    focus: [...focus],
    streaks,
    added: [...added],
    removed: [...removed],
  }
}

/* ---------- 汇总统计 ---------- */

export function summarizeLines(
  order: { id: string }[],
  states: Record<string, MemorizeLineState>,
): MemorizeLineSummary[] {
  return order.map((line, index) => {
    const st = states[line.id] ?? initLineState([])
    const maskCount = st.everMasked.filter(Boolean).length
    const revealed = maskCount - st.masked.filter(Boolean).length
    return { lineId: line.id, index, result: judgeLine(st), revealed, maskCount }
  })
}

export interface PracticeTotals {
  total: number
  perfect: number
  peeked: number
  failed: number
}

export function tally(summaries: MemorizeLineSummary[]): PracticeTotals {
  const t: PracticeTotals = { total: summaries.length, perfect: 0, peeked: 0, failed: 0 }
  for (const s of summaries) t[s.result] += 1
  return t
}

export const RESULT_LABELS: Record<LineResult, string> = {
  perfect: '一次没错',
  peeked: '看了一眼才想起',
  failed: '整句没记住',
}
