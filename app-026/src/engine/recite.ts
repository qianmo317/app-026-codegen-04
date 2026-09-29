import type { ReciteMaskMode, ReciteSession, ReciteSessionLine, Script } from '../types'

/* ---------- 可遮字 ---------- */

/**
 * 是否为可遮字：CJK 表意文字（汉字/日文汉字等）、谚文、假名。
 * 标点、数字、拉丁字母、空格不遮——遮标点没法断句，也没有考的意义。
 */
export function isMaskable(ch: string): boolean {
  if (ch.length !== 1) return false
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展 B
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0x3040 && cp <= 0x30ff) // 假名
  )
}

/** 取出一句中的可遮字（按 Unicode 码点切，兼容代理对） */
export function maskableChars(text: string): string[] {
  return Array.from(text).filter(isMaskable)
}

/* ---------- 确定性随机（续练时同一轮遮字保持一致） ---------- */

/** 字符串 → 32bit 种子（FNV-1a 变体） */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32：可种子化的 PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates 洗牌（用注入的 rng，保证可测） */
export function shuffled<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/* ---------- 遮字方案 ---------- */

export interface MaskOptions {
  mode: ReciteMaskMode
  /** 0~1：ratio 模式每句遮住的比例；random 模式被抽中句子的比例 */
  ratio: number
  /** 随机种子（通常用 剧目id + 开始时间） */
  seed: string
}

/**
 * 生成一句的遮字布尔数组（长度=可遮字数，true=遮住）。
 * - ratio：每句各自按比例随机挑字遮
 * - tail：只遮后半截（比例被忽略）
 * - random：整句要么全遮（maskAll=true 时），要么全不遮；抽句在 createSessionLines 里做
 */
export function buildLineMask(text: string, opts: MaskOptions, lineSalt: string, maskAll: boolean): boolean[] {
  const n = maskableChars(text).length
  const mask = new Array<boolean>(n).fill(false)
  if (n === 0) return mask
  if (opts.mode === 'tail') {
    const from = Math.floor(n / 2)
    for (let i = from; i < n; i++) mask[i] = true
    return mask
  }
  if (!maskAll) return mask
  if (opts.mode === 'random') return mask.fill(true)
  // ratio：每句按比例随机
  const r = Math.min(1, Math.max(0, opts.ratio))
  const count = Math.round(n * r)
  const rng = mulberry32(hashSeed(`${opts.seed}|${lineSalt}`))
  for (const idx of shuffled([...Array(n).keys()], rng).slice(0, count)) mask[idx] = true
  return mask
}

/* ---------- 练习句选取与会话构造 ---------- */

/** 按唱段顺序收集句 id；focusOnly 时只保留重点清单里的句（去重，保持顺序） */
export function selectLineIds(script: Script, segmentId: string | null, focusOnly: boolean, focusIds: string[]): string[] {
  let ids: string[]
  if (segmentId) {
    const seg = script.segments.find((s) => s.id === segmentId)
    ids = seg ? seg.lineIds.slice() : []
  } else {
    // 全剧：按段顺序拼，跳过段间重复（正常不会重复）
    const seen = new Set<string>()
    ids = []
    for (const seg of script.segments) {
      for (const id of seg.lineIds) {
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
    }
    // 不属于任何段的散句（防御）
    for (const line of script.lines) if (!seen.has(line.id)) ids.push(line.id)
  }
  if (focusOnly) {
    const set = new Set(focusIds)
    ids = ids.filter((id) => set.has(id))
  }
  return ids
}

export interface CreateSessionOpts {
  mode: ReciteMaskMode
  ratio: number
  durationMin: number
  focusOnly: boolean
  segmentId: string | null
  seed: string
  /** 当前重点清单（focusOnly 时用于过滤） */
  focusIds: string[]
}

/** 构造一轮新练习的句状态（不碰原文） */
export function createSessionLines(script: Script, opts: CreateSessionOpts): ReciteSessionLine[] {
  const ids = selectLineIds(script, opts.segmentId, opts.focusOnly, opts.focusIds)
  return buildSessionLines(script, ids, { mode: opts.mode, ratio: opts.ratio, seed: opts.seed })
}

/** 由最终句 id 列表 + 遮字选项生成会话行（random 模式在此按句抽遮） */
export function buildSessionLines(script: Script, ids: string[], mask: { mode: ReciteMaskMode; ratio: number; seed: string }): ReciteSessionLine[] {
  const lineById = new Map(script.lines.map((l) => [l.id, l]))
  const rng = mulberry32(hashSeed(`${mask.seed}|lines`))
  return ids
    .filter((id) => lineById.has(id))
    .map((id, i) => {
      const line = lineById.get(id)!
      const maskAll = mask.mode === 'random' ? rng() < mask.ratio : true
      return {
        id,
        masked: buildLineMask(line.text, { mode: mask.mode, ratio: mask.ratio, seed: mask.seed }, `${i}:${id}`, maskAll),
        status: 'none' as const,
        revealed: [],
      }
    })
}

/* ---------- 判句 ---------- */

/** 点一个方块：返回新的 revealed（已露出的字重复点不变） */
export function revealOne(line: ReciteSessionLine, charIdx: number): number[] {
  if (line.status === 'perfect') return line.revealed
  if (charIdx < 0 || charIdx >= line.masked.length) return line.revealed
  if (!line.masked[charIdx] || line.revealed.includes(charIdx)) return line.revealed
  return [...line.revealed, charIdx]
}

/** 点整句：一次露出全部遮住的字 */
export function revealAll(line: ReciteSessionLine): number[] {
  if (line.status === 'perfect') return line.revealed
  return line.masked.map((_, i) => i)
}

/**
 * 结束本句判定：
 * - 一个遮字都没有（random 没抽中、纯标点、比例算出 0 个）→ skipped，中性不计成绩
 * - 有遮字且一个没露 → perfect（一次没错）
 * - 露过（哪怕一个）→ peeked（看了一眼才想起来）
 */
export function judgeLine(line: ReciteSessionLine): ReciteSessionLine['status'] {
  if (!line.masked.some(Boolean)) return 'skipped'
  return line.revealed.length > 0 ? 'peeked' : 'perfect'
}

/* ---------- 连续计数与重点清单 ---------- */

/**
 * 依据本句判定更新「连续想不起来」计数：
 * peeked +1，perfect 归零，skipped 中性不动（本轮没考这句）。返回新计数表。
 */
export function updateStreaks(prev: Record<string, number>, id: string, status: ReciteSessionLine['status']): Record<string, number> {
  const next = { ...prev }
  if (status === 'peeked') next[id] = (next[id] ?? 0) + 1
  else if (status === 'perfect') next[id] = 0
  return next
}

/** 连着两次想不起来 → 自动进重点清单（幂等） */
export function applyStreakToFocus(focusIds: string[], id: string, streak: number): string[] {
  if (streak >= 2 && !focusIds.includes(id)) return [...focusIds, id]
  return focusIds
}

/** 完整走一遍判定，返回更新后的 streaks/focusIds（新进重点的句 id 列表便于 UI 提示） */
export function applyJudgement(
  focusIds: string[],
  streaks: Record<string, number>,
  id: string,
  status: ReciteSessionLine['status'],
): { focusIds: string[]; streaks: Record<string, number>; newlyFocused: boolean } {
  const nextStreaks = updateStreaks(streaks, id, status)
  const before = focusIds
  const nextFocus = applyStreakToFocus(focusIds, id, nextStreaks[id] ?? 0)
  return { focusIds: nextFocus, streaks: nextStreaks, newlyFocused: nextFocus !== before }
}

/** 回滚到进入练习时的重点清单快照（退出选「不保留」），计数也一并回到快照基准 */
export function rollbackFocus(current: { focusIds: string[]; streaks: Record<string, number> }, snapshot: string[]): { focusIds: string[]; streaks: Record<string, number> } {
  const streaks = { ...current.streaks }
  // 本次新进入清单的句，计数回到 1（这次确实卡了，但不累计成「连着两次」）
  for (const id of current.focusIds) {
    if (!snapshot.includes(id) && (streaks[id] ?? 0) >= 2) streaks[id] = 1
  }
  // 快照里有但当前没有的情况理论上不会发生（练习不会移除重点）
  return { focusIds: snapshot.slice(), streaks }
}

/* ---------- 会话统计 ---------- */

export interface ReciteStats {
  total: number
  practiced: number
  perfect: number
  peeked: number
  /** 本轮没考的句（未抽中/无需遮字） */
  skipped: number
  /** 新进入重点清单的句 id（最终清单 - 入场快照） */
  newFocusIds: string[]
}

export function summarize(session: ReciteSession, finalFocusIds: string[], focusSnapshot: string[]): ReciteStats {
  const snap = new Set(focusSnapshot)
  const newFocusIds = finalFocusIds.filter((id) => !snap.has(id))
  let perfect = 0
  let peeked = 0
  let skipped = 0
  for (const l of session.lines) {
    if (l.status === 'perfect') perfect += 1
    else if (l.status === 'peeked') peeked += 1
    else if (l.status === 'skipped') skipped += 1
  }
  return { total: session.lines.length, practiced: perfect + peeked, perfect, peeked, skipped, newFocusIds }
}

/* ---------- 续练兼容 ---------- */

/**
 * 续练时按当前原文校正会话：
 * - 原文已删除的句剔除
 * - 仍存在的句保留进度；遮字数组按当前可遮字数重算并尽量保留已露记录
 * 返回校正后的会话（不修改入参）。
 */
export function reconcileSession(session: ReciteSession, script: Script): ReciteSession {
  const lineById = new Map(script.lines.map((l) => [l.id, l]))
  const lines: ReciteSessionLine[] = []
  const lineIds: string[] = []
  for (const sl of session.lines) {
    const line = lineById.get(sl.id)
    if (!line) continue
    const n = maskableChars(line.text).length
    // 保留原遮字方案（续练同一轮不应换题），按新长度裁剪/补 false
    const masked = sl.masked.slice(0, n)
    while (masked.length < n) masked.push(false)
    const revealed = sl.revealed.filter((i) => i < n && masked[i])
    lines.push({ ...sl, masked, revealed })
    lineIds.push(sl.id)
  }
  return { ...session, lines, lineIds }
}
