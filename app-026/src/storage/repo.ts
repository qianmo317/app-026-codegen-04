import type { PromptSettings, Script } from '../types'
import { idb, STORE_MEMORIZE, STORE_PRACTICE, STORE_SCRIPTS, STORE_SETTINGS, STORE_TEMPLATES } from './db'
import type { MemorizeSession, PracticeHistoryEntry } from '../engine/memorize'

export const DEFAULT_SETTINGS: PromptSettings = {
  fontSizePx: 48,
  autoFit: true,
  autoScroll: true,
  speedPxPerSec: 90,
  theme: 'dark',
  holdOnCue: true,
  lockStage: false,
}

/* ---------- Scripts ---------- */

export async function listScripts(): Promise<Script[]> {
  const all = await idb.getAll<Script>(STORE_SCRIPTS)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getScript(id: string): Promise<Script | undefined> {
  return idb.get<Script>(STORE_SCRIPTS, id)
}

export async function saveScript(script: Script): Promise<void> {
  await idb.put(STORE_SCRIPTS, { ...script, updatedAt: Date.now() })
}

export async function deleteScript(id: string): Promise<void> {
  await idb.delete(STORE_SCRIPTS, id)
}

/* ---------- Templates ---------- */

export async function listTemplates(): Promise<Script[]> {
  return idb.getAll<Script>(STORE_TEMPLATES)
}

export async function saveAsTemplate(script: Script): Promise<Script> {
  const copy: Script = {
    ...structuredClone(script),
    id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: `模板·${script.title}`,
    updatedAt: Date.now(),
  }
  await idb.put(STORE_TEMPLATES, copy)
  return copy
}

export async function deleteTemplate(id: string): Promise<void> {
  await idb.delete(STORE_TEMPLATES, id)
}

export function newScriptFrom(template: Script): Script {
  return {
    ...structuredClone(template),
    id: `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: template.title.replace(/^模板·/, ''),
    updatedAt: Date.now(),
  }
}

/* ---------- Settings ---------- */

/** localStorage 直写缓存键：页面卸载时 IndexedDB 写入不可靠，用同步缓存兜底 */
const LS_SETTINGS = 'otp-settings'

export async function loadSettings(): Promise<PromptSettings> {
  const saved = await idb.get<PromptSettings & { savedAt?: number }>(STORE_SETTINGS, 'app')
  let best: (PromptSettings & { savedAt?: number }) | undefined = saved ?? undefined
  try {
    const raw = localStorage.getItem(LS_SETTINGS)
    if (raw) {
      const cached = JSON.parse(raw) as PromptSettings & { savedAt?: number }
      if (!best || (cached.savedAt ?? 0) >= (best.savedAt ?? 0)) best = cached
    }
  } catch {
    /* ignore */
  }
  if (!best) return { ...DEFAULT_SETTINGS }
  const rec = { ...best } as PromptSettings & Record<string, unknown>
  delete rec.savedAt
  return { ...DEFAULT_SETTINGS, ...rec }
}

/** 立即持久化：localStorage 同步直写 + IndexedDB 异步落盘（不做防抖，避免卸载丢设置） */
export function saveSettings(s: PromptSettings): void {
  const rec = { ...s, savedAt: Date.now() }
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(rec))
  } catch {
    /* ignore */
  }
  void idb.put(STORE_SETTINGS, rec, 'app')
}

/* ---------- Practice（本条已练 N 次） ---------- */

export interface PracticeRecord {
  id: string
  counts: Record<string, number>
}

export async function getPracticeCounts(scriptId: string): Promise<Record<string, number>> {
  const rec = await idb.get<PracticeRecord>(STORE_PRACTICE, scriptId)
  return rec?.counts ?? {}
}

export async function bumpPractice(scriptId: string, lineIds: string[]): Promise<Record<string, number>> {
  const counts = await getPracticeCounts(scriptId)
  for (const id of lineIds) counts[id] = (counts[id] ?? 0) + 1
  await idb.put(STORE_PRACTICE, { id: scriptId, counts } satisfies PracticeRecord, scriptId)
  return counts
}

/* ---------- 默记练习（重点清单 + 进行中会话） ---------- */

export interface MemorizeRecord {
  id: string
  /** 重点清单 line id：连着两次没记住的句子 */
  focus: string[]
  /** 每句连续没记住/提示的次数（0/1/2…） */
  streaks: Record<string, number>
  /** 进行中的练习会话 */
  session?: MemorizeSession
  /** 最近练习记录（最多 20 条） */
  history: PracticeHistoryEntry[]
  updatedAt: number
}

const LS_MEMORIZE = 'otp-memorize'
const EMPTY_REC: Omit<MemorizeRecord, 'id'> = { focus: [], streaks: {}, history: [], updatedAt: 0 }

/**
 * 读：IndexedDB 为主，localStorage 同步快照兜底（页面卸载时 IDB 写入可能丢失），
 * savedAt/updatedAt 较新者胜。
 */
export async function getMemorize(scriptId: string): Promise<MemorizeRecord> {
  const fromDb = await idb.get<MemorizeRecord>(STORE_MEMORIZE, scriptId)
  let best = fromDb as (MemorizeRecord & { savedAt?: number }) | undefined
  try {
    const raw = localStorage.getItem(`${LS_MEMORIZE}-${scriptId}`)
    if (raw) {
      const cached = JSON.parse(raw) as MemorizeRecord & { savedAt?: number }
      if (!best || (cached.updatedAt ?? 0) >= (best.updatedAt ?? 0)) best = cached
    }
  } catch {
    /* ignore */
  }
  return { ...EMPTY_REC, ...(best ?? {}), id: scriptId }
}

/** 立即持久化：localStorage 同步直写 + IndexedDB 异步落盘 */
export function saveMemorize(rec: MemorizeRecord): void {
  const next = { ...rec, updatedAt: Date.now() }
  try {
    localStorage.setItem(`${LS_MEMORIZE}-${rec.id}`, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  void idb.put(STORE_MEMORIZE, next)
}

/** 只更新会话（中途退出续练用），不触碰重点清单 */
export function saveMemorizeSession(scriptId: string, session: MemorizeSession | undefined): void {
  void getMemorize(scriptId).then((rec) => {
    saveMemorize({ ...rec, session })
  })
}

/** 清理已不存在的句子（剧目被编辑删行后，重点清单不残留）；有改动才落库 */
export async function pruneMemorize(scriptId: string, validLineIds: Set<string>): Promise<MemorizeRecord> {
  // 重读最新记录，避免与并发的 getMemorize 竞争覆盖
  const rec = await getMemorize(scriptId)
  let changed = false
  const focus = rec.focus.filter((id) => {
    if (validLineIds.has(id)) return true
    changed = true
    return false
  })
  const streaks: Record<string, number> = {}
  for (const [id, n] of Object.entries(rec.streaks)) {
    if (validLineIds.has(id)) streaks[id] = n
    else changed = true
  }
  let session = rec.session
  if (session) {
    const order = session.order.filter((id) => validLineIds.has(id))
    const states: MemorizeSession['states'] = {}
    for (const [id, st] of Object.entries(session.states)) {
      if (validLineIds.has(id)) states[id] = st
    }
    if (order.length !== session.order.length) changed = true
    // 句子被删导致 cursor 越界则夹紧
    const cursor = Math.min(session.cursor, Math.max(order.length - 1, 0))
    if (cursor !== session.cursor) changed = true
    // 所有句子都已提交结果（练完但未在统计页选择就关页）→ 不做续练
    const allCommitted = order.every((lid) => states[lid]?.result)
    if (allCommitted) {
      session = undefined
      changed = true
    } else if (changed) session = { ...session, order, states, cursor }
  }
  const next: MemorizeRecord = { ...rec, focus, streaks, session }
  if (changed) saveMemorize(next)
  return next
}

