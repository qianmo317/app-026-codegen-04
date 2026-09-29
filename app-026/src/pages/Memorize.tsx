import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, navigate } from '../router'
import { useScript } from '../state/hooks'
import * as repo from '../storage/repo'
import type { MemorizeRecord } from '../storage/repo'
import {
  applyFocus,
  buildLineOrder,
  initLineState,
  judgeLine,
  makeLineMask,
  makeRng,
  RESULT_LABELS,
  summarizeLines,
  tally,
} from '../engine/memorize'
import type {
  LineResult,
  MaskMode,
  MemorizeSession,
  MemorizeSettings,
  MemorizeLineState,
  PracticeHistoryEntry,
} from '../engine/memorize'
import { ArrowLeft, ArrowRight, Brain, CheckCircle2, Clock, ListChecks, XCircle } from 'lucide-react'

const LS_LAST_SETTINGS = 'otp-memorize-last-settings'
const DURATION_OPTIONS = [0, 5, 10, 15, 20, 30]

interface LastSettings {
  ratio: number
  mode: MaskMode
  durationMin: number
}

function loadLastSettings(): LastSettings {
  try {
    const raw = localStorage.getItem(LS_LAST_SETTINGS)
    if (raw) return { ratio: 0.5, mode: 'ratio', durationMin: 10, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ratio: 0.5, mode: 'ratio', durationMin: 10 }
}

type Phase = 'setup' | 'practice' | 'stats'

interface FinishedStats {
  practiced: ReturnType<typeof summarizeLines>
  added: string[]
  removed: string[]
  timedOut: boolean
}

export function Memorize({ id }: { id: string }) {
  const { script } = useScript(id)
  const [record, setRecord] = useState<MemorizeRecord | null>(null)
  const [phase, setPhase] = useState<Phase>('setup')
  const [session, setSession] = useState<MemorizeSession | null>(null)
  const [stats, setStats] = useState<FinishedStats | null>(null)
  const [showExit, setShowExit] = useState(false)

  // 记录与文稿分别加载；文稿就绪后清理已删除句子的残留重点/会话
  useEffect(() => {
    if (id) repo.getMemorize(id).then(setRecord)
  }, [id])
  useEffect(() => {
    if (!id || !script) return
    const valid = new Set(script.lines.map((l) => l.id))
    repo.pruneMemorize(id, valid).then((r) => setRecord(r))
  }, [id, script])

  if (!script || !record) return <div className="page center">加载中…</div>

  const focusSet = new Set(record.focus)

  return (
    <div className="page narrow memo-page">
      <header className="page-head">
        <h1><Brain size={22} /> 默记练习 · {script.title}</h1>
        <Link className="btn btn-ghost" to={`/script/${id}`}><ArrowLeft size={16} /> 返回文稿</Link>
      </header>

      {phase === 'setup' && (
        <Setup
          script={script}
          record={record}
          onRecordChange={setRecord}
          onStarted={(sess) => {
            setSession(sess)
            setPhase('practice')
          }}
          onResumed={(sess) => {
            setSession(sess)
            setPhase('practice')
          }}
        />
      )}

      {phase === 'practice' && session && (
        <Practice
          scriptId={id}
          scriptLines={script.lines}
          session={session}
          setSession={setSession}
          onExit={() => setShowExit(true)}
          onFinish={(finished, timedOut) => {
            const practiced = summarizeLines(
              session.order.slice(0, finished + 1).map((lid) => ({ id: lid })),
              session.states,
            )
            // 仅试算新增/毕业数用于展示；是否落库由统计页「留下/不保留」决定
            const preview = applyFocus(record.focus, record.streaks, practiced, true)
            setStats({ practiced, added: preview.added, removed: preview.removed, timedOut })
            setPhase('stats')
          }}
          showExit={showExit}
          cancelExit={() => setShowExit(false)}
        />
      )}

      {phase === 'stats' && session && stats && (
        <Stats
          scriptId={id}
          scriptLines={script.lines}
          segments={script.segments}
          session={session}
          stats={stats}
          record={record}
          setRecord={setRecord}
          onRestart={() => {
            setStats(null)
            setSession(null)
            setPhase('setup')
            repo.getMemorize(id).then(setRecord)
          }}
        />
      )}

      {focusSet.size > 0 && phase === 'setup' && (
        <p className="muted memo-focus-hint">
          <ListChecks size={14} /> 重点清单 {record.focus.length} 句：连着两次没记住的句子自动收进来。
        </p>
      )}
    </div>
  )
}

/* ==================== 设置阶段 ==================== */

function Setup({
  script,
  record,
  onRecordChange,
  onStarted,
  onResumed,
}: {
  script: NonNullable<ReturnType<typeof useScript>['script']>
  record: MemorizeRecord
  onRecordChange: (r: MemorizeRecord) => void
  onStarted: (s: MemorizeSession) => void
  onResumed: (s: MemorizeSession) => void
}) {
  const last = loadLastSettings()
  const [segSel, setSegSel] = useState<Set<string>>(() => new Set(script.segments.map((s) => s.id)))
  const [focusOnly, setFocusOnly] = useState(false)
  const [mode, setMode] = useState<MaskMode>(last.mode)
  const [ratio, setRatio] = useState(last.ratio)
  const [durationMin, setDurationMin] = useState(last.durationMin)

  const focusSet = useMemo(() => new Set(record.focus), [record])

  const previewCount = useMemo(() => {
    const order = buildLineOrder(script.lines, script.segments, [...segSel], focusSet, focusOnly)
    return order.length
  }, [script, segSel, focusSet, focusOnly])

  const toggleSeg = (sid: string) => {
    const next = new Set(segSel)
    if (next.has(sid)) next.delete(sid)
    else next.add(sid)
    setSegSel(next)
  }

  const start = () => {
    const settings: MemorizeSettings = {
      // tail 不依赖比例，但保留用户上次选择的比例，续练卡片也能展示
      ratio,
      mode,
      durationMin,
      segmentIds: [...segSel],
      focusOnly,
    }
    const ordered = buildLineOrder(script.lines, script.segments, [...segSel], focusSet, focusOnly)
    const seed = Date.now() ^ Math.floor(Math.random() * 0xffffffff)
    const states: Record<string, MemorizeLineState> = {}
    ordered.forEach((line, i) => {
      const rng = makeRng((seed + i * 2654435761) >>> 0)
      states[line.id] = initLineState(makeLineMask(line.text, mode, ratio, rng))
    })
    const sess: MemorizeSession = {
      startedAt: Date.now(),
      settings,
      order: ordered.map((l) => l.id),
      cursor: 0,
      seed,
      states,
    }
    try {
      localStorage.setItem(LS_LAST_SETTINGS, JSON.stringify({ ratio, mode, durationMin }))
    } catch {
      /* ignore */
    }
    repo.saveMemorize({ ...record, session: sess })
    onStarted(sess)
  }

  const modeOptions: { value: MaskMode; label: string; hint: string }[] = [
    { value: 'ratio', label: '按比例遮字', hint: '每句按比例随机遮住单字' },
    { value: 'tail', label: '只遮后半截', hint: '每句后半句遮住，前半截做引子' },
    { value: 'random', label: '按句随机抽', hint: '按比例随机抽整句全遮，其余全露' },
  ]

  return (
    <>
      {record.session && (
        <section className="panel memo-resume" data-testid="memo-resume">
          <h2><Clock size={16} /> 上次练到一半</h2>
          <p className="muted">
            从第 {Math.min(record.session.cursor + 1, record.session.order.length)} 句接着练 ·{' '}
            共 {record.session.order.length} 句 ·{' '}
            {MODE_LABEL[record.session.settings.mode]}
            {record.session.settings.durationMin > 0 ? ` · 限时 ${record.session.settings.durationMin} 分钟` : ' · 不限时'}
            {record.session.settings.focusOnly ? ' · 仅重点清单' : ''}
          </p>
          <div className="form-row">
            <button className="btn" data-testid="memo-resume-btn" onClick={() => onResumed(record.session!)}>
              接着上次练
            </button>
            <button
              className="btn btn-ghost"
              data-testid="memo-discard-session"
              onClick={() => {
                const next = { ...record, session: undefined }
                repo.saveMemorize(next)
                onRecordChange(next)
              }}
            >
              放弃旧进度
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>练习范围</h2>
        <div className="seg-chips memo-chips" data-testid="memo-segments">
          {script.segments.map((seg) => (
            <button
              key={seg.id}
              className={`chip${segSel.has(seg.id) ? ' active' : ''}`}
              data-testid="memo-seg"
              data-active={segSel.has(seg.id)}
              onClick={() => toggleSeg(seg.id)}
            >
              {seg.title}（{seg.lineIds.length}）
            </button>
          ))}
          {script.segments.length === 0 && <span className="muted">文稿还没有分段</span>}
        </div>
        <label className="chk memo-chk">
          <input
            type="checkbox"
            data-testid="memo-focus-only"
            checked={focusOnly}
            disabled={record.focus.length === 0}
            onChange={(e) => setFocusOnly(e.target.checked)}
          />
          只练重点清单（{record.focus.length} 句）
        </label>
      </section>

      {record.focus.length > 0 && (
        <section className="panel" data-testid="memo-focus-panel">
          <h2><ListChecks size={16} /> 重点清单（{record.focus.length} 句）</h2>
          <ul className="memo-result-list">
            {record.focus.map((lid) => {
              const line = script.lines.find((l) => l.id === lid)
              if (!line) return null
              const segTitle = script.segments.find((s) => s.lineIds.includes(lid))?.title
              return (
                <li key={lid} data-testid="memo-focus-item">
                  <span className="muted memo-result-seg">{segTitle ?? ''}</span>
                  {line.role && <span className="memo-result-role">{line.role}</span>}
                  <span className="memo-result-text">{line.text}</span>
                  <button
                    className="op op-danger memo-focus-x"
                    title="从重点清单移除"
                    data-testid="memo-focus-remove"
                    onClick={() => {
                      const next = {
                        ...record,
                        focus: record.focus.filter((x) => x !== lid),
                        streaks: { ...record.streaks, [lid]: 0 },
                      }
                      repo.saveMemorize(next)
                      onRecordChange(next)
                    }}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="form-row">
            <button
              className="btn btn-ghost btn-small"
              data-testid="memo-focus-clear"
              onClick={() => {
                if (!confirm('清空重点清单？')) return
                const next = { ...record, focus: [], streaks: {} }
                repo.saveMemorize(next)
                onRecordChange(next)
              }}
            >
              清空清单
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>遮字方式</h2>
        <div className="memo-modes" data-testid="memo-modes">
          {modeOptions.map((opt) => (
            <button
              key={opt.value}
              className={`memo-mode${mode === opt.value ? ' active' : ''}`}
              data-testid={`memo-mode-${opt.value}`}
              data-active={mode === opt.value}
              onClick={() => setMode(opt.value)}
            >
              <b>{opt.label}</b>
              <span className="muted">{opt.hint}</span>
            </button>
          ))}
        </div>

        {mode !== 'tail' && (
          <label className="set-row">
            <span>{mode === 'random' ? '抽中句子的比例' : '遮字比例'}</span>
            <input
              type="range" min={0} max={100} step={5}
              data-testid="memo-ratio"
              value={Math.round(ratio * 100)}
              onChange={(e) => setRatio(Number(e.target.value) / 100)}
            />
            <b data-testid="memo-ratio-display">{Math.round(ratio * 100)}%</b>
          </label>
        )}

        <label className="set-row">
          <span>练习时长</span>
          <select data-testid="memo-duration" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}>
            {DURATION_OPTIONS.map((m) => (
              <option key={m} value={m}>{m === 0 ? '不限时' : `${m} 分钟`}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel memo-start-bar">
        <p className="muted">本次共 {previewCount} 句{previewCount === 0 ? '（范围里没有可练的句子）' : ''}</p>
        <button className="btn" data-testid="memo-start" disabled={previewCount === 0} onClick={start}>
          开始默记
        </button>
      </section>
    </>
  )
}

const MODE_LABEL: Record<MaskMode, string> = { ratio: '按比例遮字', tail: '只遮后半截', random: '按句随机抽' }

/* ==================== 练习阶段 ==================== */

function Practice({
  scriptId,
  scriptLines,
  session: initial,
  setSession,
  onExit,
  onFinish,
  showExit,
  cancelExit,
}: {
  scriptId: string
  scriptLines: NonNullable<ReturnType<typeof useScript>['script']>['lines']
  session: MemorizeSession
  setSession: (s: MemorizeSession) => void
  onExit: () => void
  onFinish: (cursor: number, timedOut: boolean) => void
  showExit: boolean
  cancelExit: () => void
}) {
  const [session, setLocal] = useState(initial)
  const [now, setNow] = useState(Date.now())
  const sessRef = useRef(session)
  sessRef.current = session
  const finishedRef = useRef(false)

  const lineById = useMemo(() => new Map(scriptLines.map((l) => [l.id, l])), [scriptLines])
  const line = lineById.get(session.order[session.cursor])
  const st = line ? session.states[line.id] : undefined

  const persist = (next: MemorizeSession) => {
    setLocal(next)
    setSession(next)
    // 只更新会话字段，避免用陈旧的 record 覆盖重点清单
    repo.saveMemorizeSession(scriptId, next)
  }

  /** 给当前句的 state 补上最终判定结果 */
  const commitCurrent = (s: MemorizeSession): MemorizeSession => {
    const cur = lineById.get(s.order[s.cursor])
    const curSt = cur ? s.states[cur.id] : undefined
    if (!cur || !curSt || curSt.result) return s
    const states = { ...s.states }
    states[cur.id] = { ...curSt, result: judgeLine(curSt) }
    return { ...s, states }
  }

  // 计时
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])

  const limitMs = session.settings.durationMin > 0 ? session.settings.durationMin * 60_000 : 0
  const elapsed = Math.max(0, now - session.startedAt)
  const remaining = limitMs > 0 ? Math.max(0, limitMs - elapsed) : 0

  useEffect(() => {
    if (limitMs > 0 && remaining <= 0 && !finishedRef.current) {
      finishedRef.current = true
      const committed = commitCurrent(sessRef.current)
      repo.saveMemorizeSession(scriptId, committed)
      onFinish(committed.cursor, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining <= 0])

  // 键盘：Enter / → 下一句（按钮先失焦，避免合成 click 连跳两句）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (tag === 'BUTTON') (e.target as HTMLElement).blur()
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.cursor, line?.id])

  if (!line || !st) {
    // 句子已被删除等异常：直接结算
    if (!finishedRef.current) {
      finishedRef.current = true
      setTimeout(() => onFinish(session.cursor, false), 0)
    }
    return null
  }

  const revealChar = (charIdx: number) => {
    if (st.fullRevealed || !st.masked[charIdx]) return
    const states = { ...session.states }
    const masked = st.masked.slice()
    masked[charIdx] = false
    states[line.id] = { ...st, masked }
    persist({ ...session, states })
  }

  const revealAll = () => {
    if (st.fullRevealed) return
    const states = { ...session.states }
    states[line.id] = { ...st, masked: st.masked.map(() => false), fullRevealed: true }
    persist({ ...session, states })
  }

  const goNext = () => {
    if (finishedRef.current) return
    const committed = commitCurrent(session)
    const next: MemorizeSession = { ...committed, cursor: session.cursor + 1 }
    if (next.cursor >= session.order.length) {
      finishedRef.current = true
      persist(next)
      onFinish(session.order.length - 1, false)
    } else {
      persist(next)
    }
  }

  const saveAndExit = () => {
    // 进度（含当前句露出状态）已实时保存，这里直接走
    navigate(`/script/${scriptId}`)
  }

  const finishEarly = () => {
    finishedRef.current = true
    const committed = commitCurrent(session)
    persist(committed)
    onFinish(session.cursor, false)
  }

  const chars = Array.from(line.text)
  const revealedCount = st.everMasked.filter(Boolean).length - st.masked.filter(Boolean).length

  return (
    <div className="memo-practice">
      <div className="memo-bar">
        <button className="tbtn" data-testid="memo-exit" onClick={onExit} title="退出"><ArrowLeft size={16} /></button>
        <div className="memo-progress" data-testid="memo-progress">
          第 <b>{session.cursor + 1}</b> / {session.order.length} 句
        </div>
        <div className={`memo-timer${limitMs > 0 && remaining < 60_000 ? ' urgent' : ''}`} data-testid="memo-timer">
          <Clock size={14} />
          {limitMs > 0 ? formatTime(remaining) : formatTime(elapsed)}
          {limitMs > 0 && <span className="muted"> / {formatTime(limitMs)}</span>}
        </div>
      </div>

      <div className="memo-card panel" data-testid="memo-card" data-full={st.fullRevealed}>
        {line.role && <div className="memo-role">{line.role}</div>}
        <div className="memo-line" data-testid="memo-line" onClick={revealAll}>
          {chars.map((ch, i) => {
            const maskable = st.masked[i] !== undefined || st.everMasked[i]
            if (maskable && st.masked[i]) {
              return (
                <button
                  key={i}
                  className="memo-cell"
                  data-testid="memo-cell"
                  data-char-index={i}
                  onClick={(e) => {
                    e.stopPropagation()
                    revealChar(i)
                  }}
                >
                  ■
                </button>
              )
            }
            return (
              <span key={i} className={maskable ? 'memo-char' : 'memo-punct'}>
                {ch === ' ' ? ' ' : ch}
              </span>
            )
          })}
        </div>
        <p className="muted memo-hint">
          点方块露出单字（已看 {revealedCount}），点整句空白处或下方按钮一次全露
          {st.fullRevealed && <span className="memo-failed-flag">· 已整句露出，记为「没记住」</span>}
        </p>
      </div>

      <div className="memo-actions">
        <button className="btn btn-ghost" data-testid="memo-reveal-all" onClick={revealAll} disabled={st.fullRevealed}>
          整句全露
        </button>
        <button className="btn btn-big" data-testid="memo-next" onClick={goNext}>
          {session.cursor + 1 >= session.order.length ? '完成练习' : '下一句'} <ArrowRight size={16} />
        </button>
      </div>

      {showExit && (
        <div className="modal" data-testid="memo-exit-modal">
          <div className="modal-box">
            <h3>先停一下？</h3>
            <p className="muted">进度已自动保存，可以下次接着第 {session.cursor + 1} 句练。</p>
            <div className="form-row">
              <button className="btn" data-testid="memo-exit-save" onClick={saveAndExit}>存进度退出</button>
              <button className="btn btn-ghost" data-testid="memo-exit-finish" onClick={finishEarly}>结束并看统计</button>
              <button className="btn btn-ghost" data-testid="memo-exit-cancel" onClick={cancelExit}>接着练</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ==================== 统计阶段 ==================== */

function Stats({
  scriptId,
  scriptLines,
  segments,
  session,
  stats,
  record,
  setRecord,
  onRestart,
}: {
  scriptId: string
  scriptLines: NonNullable<ReturnType<typeof useScript>['script']>['lines']
  segments: NonNullable<ReturnType<typeof useScript>['script']>['segments']
  session: MemorizeSession
  stats: FinishedStats
  record: MemorizeRecord
  setRecord: (r: MemorizeRecord) => void
  onRestart: () => void
}) {
  const [decided, setDecided] = useState(false)
  const [kept, setKept] = useState<boolean | null>(null)
  const totals = tally(stats.practiced)
  const lineById = useMemo(() => new Map(scriptLines.map((l) => [l.id, l])), [scriptLines])

  // 结算时已按 keep=true 试算；此处分发「保留 / 不保留」
  const decide = (keep: boolean) => {
    const upd = applyFocus(record.focus, record.streaks, stats.practiced, keep)
    const historyEntry: PracticeHistoryEntry = {
      at: Date.now(),
      mode: session.settings.mode,
      durationMin: session.settings.durationMin,
      focusOnly: session.settings.focusOnly,
      totals,
      addedCount: keep ? upd.added.length : 0,
    }
    const next: repo.MemorizeRecord = {
      ...record,
      focus: upd.focus,
      streaks: upd.streaks,
      session: undefined,
      history: [historyEntry, ...record.history].slice(0, 20),
    }
    repo.saveMemorize(next)
    setRecord(next)
    setKept(keep)
    setDecided(true)
  }

  const segOfLine = useMemo(() => {
    const m = new Map<string, string>()
    for (const seg of segments) for (const lid of seg.lineIds) m.set(lid, seg.title)
    return m
  }, [segments])

  const groups: { result: LineResult; icon: React.ReactNode; cls: string }[] = [
    { result: 'failed', icon: <XCircle size={16} />, cls: 'failed' },
    { result: 'peeked', icon: <ListChecks size={16} />, cls: 'peeked' },
    { result: 'perfect', icon: <CheckCircle2 size={16} />, cls: 'perfect' },
  ]

  return (
    <div className="memo-stats" data-testid="memo-stats">
      <section className="panel">
        <h2>{stats.timedOut ? '时间到，练习结束' : '练习结束'}</h2>
        <div className="memo-totals">
          <div className="memo-total perfect" data-testid="memo-total-perfect">
            <b>{totals.perfect}</b><span>一次没错</span>
          </div>
          <div className="memo-total peeked" data-testid="memo-total-peeked">
            <b>{totals.peeked}</b><span>看了一眼</span>
          </div>
          <div className="memo-total failed" data-testid="memo-total-failed">
            <b>{totals.failed}</b><span>没记住</span>
          </div>
        </div>
        <p className="muted">
          本次练了 {totals.total} 句 / 共 {session.order.length} 句
          {stats.added.length > 0 && <> · 新增重点 <b className="memo-failed-text">{stats.added.length}</b> 句</>}
          {stats.removed.length > 0 && <> · 重点毕业 <b className="ok">{stats.removed.length}</b> 句</>}
        </p>
      </section>

      {groups.map(({ result, icon, cls }) => {
        const items = stats.practiced.filter((s) => s.result === result)
        if (items.length === 0) return null
        return (
          <section className="panel" key={result} data-testid={`memo-group-${result}`}>
            <h2 className={`memo-group-title ${cls}`}>{icon} {RESULT_LABELS[result]}（{items.length}）</h2>
            <ul className="memo-result-list">
              {items.map((s) => {
                const line = lineById.get(s.lineId)
                if (!line) return null
                return (
                  <li key={s.lineId} data-testid="memo-result-item" data-result={result}>
                    <span className="muted memo-result-seg">{segOfLine.get(s.lineId) ?? ''}</span>
                    {line.role && <span className="memo-result-role">{line.role}</span>}
                    <span className="memo-result-text">{line.text}</span>
                    {result === 'peeked' && <span className="muted">（看了 {s.revealed}/{s.maskCount} 字）</span>}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

      <section className="panel memo-decide" data-testid="memo-decide">
        {!decided ? (
          <>
            <h2>重点清单要留下吗？</h2>
            <p className="muted">
              连着两次没记住的句子已自动收进重点清单（本次{stats.added.length > 0 ? `新增 ${stats.added.length} 句` : '没有新增'}）。
              下次可以只练这份清单。
            </p>
            <div className="form-row">
              <button className="btn" data-testid="memo-keep" onClick={() => decide(true)}>留下清单</button>
              <button className="btn btn-ghost" data-testid="memo-discard" onClick={() => decide(false)}>不保留</button>
            </div>
          </>
        ) : (
          <>
            <h2>{kept ? '重点清单已保留' : '本次未改动重点清单'}</h2>
            <div className="form-row">
              <button className="btn" data-testid="memo-again" onClick={onRestart}>再练一轮</button>
              <Link className="btn btn-ghost" to={`/script/${scriptId}`} data-testid="memo-back">返回文稿</Link>
              <Link className="btn btn-ghost" to="/">回首页</Link>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function formatTime(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}
