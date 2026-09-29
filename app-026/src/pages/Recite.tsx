import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '../router'
import { useAsync } from '../state/hooks'
import * as repo from '../storage/repo'
import type { ReciteMaskMode, ReciteSession, ReciteSessionLine, ReciteState, Script } from '../types'
import {
  applyJudgement,
  buildSessionLines,
  createSessionLines,
  isMaskable,
  judgeLine,
  reconcileSession,
  revealAll,
  revealOne,
  rollbackFocus,
  selectLineIds,
  summarize,
} from '../engine/recite'
import { ArrowLeft, Brain, Eye, EyeOff, Flag, Play, RotateCcw, Timer, Trash2, X } from 'lucide-react'

type Phase = 'setup' | 'practice' | 'report'

const MODE_LABELS: { key: ReciteMaskMode; label: string; hint: string }[] = [
  { key: 'ratio', label: '按比例遮字', hint: '每句按比例随机遮住一部分字' },
  { key: 'tail', label: '只遮后半截', hint: '每句后半部分遮住，前半截提示' },
  { key: 'random', label: '按句随机抽遮', hint: '随机抽中整句全遮，其余全露' },
]

const DURATION_OPTIONS = [0, 5, 10, 15, 20, 30]

export function Recite({ id }: { id: string }) {
  const { data: script } = useAsync(() => repo.getScript(id) as Promise<Script | undefined>, [id])
  const [rec, setRec] = useState<ReciteState | null>(null)
  const [phase, setPhase] = useState<Phase>('setup')
  const [session, setSession] = useState<ReciteSession | null>(null)
  const [showExit, setShowExit] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [, setTick] = useState(0) // 每秒强制刷新倒计时显示

  // 练习配置
  const [segmentId, setSegmentId] = useState<string>('') // '' = 全剧
  const [focusOnly, setFocusOnly] = useState(false)
  const [mode, setMode] = useState<ReciteMaskMode>('ratio')
  const [ratio, setRatio] = useState(0.5)
  const [durationMin, setDurationMin] = useState(10)

  // 最新值的 ref（卸载/隐藏时持久化用）
  const sessionRef = useRef<ReciteSession | null>(null)
  const recRef = useRef<ReciteState | null>(null)
  sessionRef.current = session
  recRef.current = rec

  useEffect(() => {
    if (!id) return
    repo.getReciteState(id).then(setRec)
  }, [id])

  const flush = useCallback(() => {
    const r = recRef.current
    if (!r || !id) return
    void repo.saveReciteState(id, { ...r, session: sessionRef.current ?? undefined })
  }, [id])

  // 关闭/切走页面前兜底存盘（接着上次练）
  useEffect(() => {
    const onHide = () => flush()
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [flush])

  /**
   * 倒计时挂在根组件上（而不是 PracticeView）：判句 setState 会重挂 PracticeView，
   * 挂在这里跨句连续跑，不跳秒。每秒直写 sessionRef 并强制刷新；每 10 秒落盘。
   * 注意：必须在「加载中」早返回之前声明（hooks 数量恒定）。
   */
  useEffect(() => {
    if (phase !== 'practice' || !sessionRef.current || sessionRef.current.remainingSec === null) return
    const t = window.setInterval(() => {
      const s = sessionRef.current
      if (!s || s.remainingSec === null || s.remainingSec <= 0) return
      s.remainingSec -= 1
      setTick((v) => v + 1)
      if (s.remainingSec % 10 === 0) flush()
      if (s.remainingSec === 0) {
        flush()
        setTimedOut(true)
        setPhase('report')
      }
    }, 1000)
    return () => window.clearInterval(t)
  }, [phase, session?.startedAt, flush])

  // 当前配置下本轮可练句数（放在早返回之前以保证 hooks 数量恒定）
  const availableCount = useMemo(
    () => (script ? selectLineIds(script, segmentId || null, focusOnly, rec?.focusIds ?? []).length : 0),
    [script, segmentId, focusOnly, rec?.focusIds],
  )

  if (!script || !rec) return <div className="page center">加载中…</div>

  /* ---------- 持久化 ---------- */

  const persist = (nextSession: ReciteSession | null, nextRec: ReciteState) => {
    sessionRef.current = nextSession
    recRef.current = nextRec
    setSession(nextSession)
    setRec(nextRec)
    void repo.saveReciteState(script.id, { ...nextRec, session: nextSession ?? undefined })
  }

  /* ---------- 开始 / 续练 / 放弃 ---------- */

  const startFresh = () => {
    const seed = `${script.id}:${Date.now()}`
    const lines = createSessionLines(script, {
      mode,
      ratio,
      durationMin,
      focusOnly,
      segmentId: segmentId || null,
      seed,
      focusIds: rec.focusIds,
    })
    const sess: ReciteSession = {
      maskMode: mode,
      ratio,
      durationMin,
      remainingSec: durationMin > 0 ? durationMin * 60 : null,
      lineIds: lines.map((l) => l.id),
      focusOnly,
      lines,
      focusSnapshot: rec.focusIds.slice(),
      startedAt: Date.now(),
    }
    setTimedOut(false)
    persist(sess, rec)
    setPhase('practice')
  }

  const resume = () => {
    if (!rec.session) return
    const sess = reconcileSession(rec.session, script)
    setTimedOut(sess.remainingSec === 0)
    persist(sess, rec)
    setPhase('practice')
  }

  const abandonSession = () => {
    if (!confirm('放弃本轮未完成的练习？（重点清单保留，只是本轮进度作废）')) return
    persist(null, rec)
  }

  /* ---------- 练习中操作 ---------- */

  const curIdx = session?.lines.findIndex((l) => l.status === 'none') ?? -1
  const curLine = session && curIdx >= 0 ? session.lines[curIdx] : null

  const patchCurLine = (patch: Partial<ReciteSessionLine>) => {
    if (!session || !curLine) return
    const lines = session.lines.map((l) => (l.id === curLine.id ? { ...l, ...patch } : l))
    persist({ ...session, lines }, recRef.current!)
  }

  const onRevealOne = (charIdx: number) => {
    if (!curLine) return
    patchCurLine({ revealed: revealOne(curLine, charIdx) })
  }

  const onRevealAll = () => {
    if (!curLine) return
    patchCurLine({ revealed: revealAll(curLine) })
  }

  const goNext = () => {
    if (!session || !curLine) return
    const status = judgeLine(curLine)
    const judged: ReciteSessionLine = { ...curLine, status }
    const adj = applyJudgement(rec.focusIds, rec.streaks, curLine.id, status)
    const lines = session.lines.map((l) => (l.id === curLine.id ? judged : l))
    const done = lines.every((l) => l.status !== 'none')
    persist({ ...session, lines }, { ...rec, focusIds: adj.focusIds, streaks: adj.streaks })
    if (done) setPhase('report')
  }

  /* ---------- 中途退出（保留 / 不保留重点清单） ---------- */

  const exitKeep = () => {
    flush()
    setShowExit(false)
    setPhase('setup')
  }

  const exitDiscard = () => {
    if (!session) return
    const rolled = rollbackFocus({ focusIds: rec.focusIds, streaks: rec.streaks }, session.focusSnapshot)
    // 「不保留」只回滚本轮新进的重点；进度仍在（下次接着这一句练）
    persist(sessionRef.current, { ...rec, ...rolled })
    setShowExit(false)
    setPhase('setup')
  }

  /* ---------- 报告页结束 ---------- */

  const finish = (keep: boolean) => {
    let nextRec = rec
    if (!keep && session) {
      nextRec = { ...rec, ...rollbackFocus({ focusIds: rec.focusIds, streaks: rec.streaks }, session.focusSnapshot) }
    }
    persist(null, nextRec)
    setTimedOut(false)
    setPhase('setup')
  }

  /** 同范围重新随机，再来一轮 */
  const again = () => {
    if (!session) {
      setPhase('setup')
      return
    }
    const lines = buildSessionLines(script, session.lineIds, {
      mode: session.maskMode,
      ratio: session.ratio,
      seed: `${script.id}:again:${Date.now()}`,
    })
    const sess: ReciteSession = {
      ...session,
      remainingSec: session.durationMin > 0 ? session.durationMin * 60 : null,
      lines,
      focusSnapshot: rec.focusIds.slice(),
      startedAt: Date.now(),
    }
    setTimedOut(false)
    persist(sess, rec)
    setPhase('practice')
  }

  /** 报告页里没练完：原会话不动，回到练习页接着练；时间已到则补满一轮时长 */
  const continueRest = () => {
    if (!session) return
    const next = session.remainingSec === 0 && session.durationMin > 0
      ? { ...session, remainingSec: session.durationMin * 60 }
      : session
    setTimedOut(false)
    persist(next, rec)
    setPhase('practice')
  }

  const removeFocus = (lineId: string) => {
    persist(null, {
      ...rec,
      focusIds: rec.focusIds.filter((f) => f !== lineId),
      streaks: { ...rec.streaks, [lineId]: 0 },
    })
  }

  return (
    <div className="page narrow recite-page">
      <header className="page-head">
        <Link className="btn btn-ghost btn-small" to={`/script/${script.id}`} data-testid="recite-back">
          <ArrowLeft size={14} /> 返回
        </Link>
        <h1><Brain size={22} /> 默记练习 · {script.title}</h1>
      </header>

      {phase === 'setup' && (
        <SetupView
          script={script}
          rec={rec}
          session={rec.session ?? null}
          segmentId={segmentId}
          setSegmentId={setSegmentId}
          focusOnly={focusOnly}
          setFocusOnly={setFocusOnly}
          mode={mode}
          setMode={setMode}
          ratio={ratio}
          setRatio={setRatio}
          durationMin={durationMin}
          setDurationMin={setDurationMin}
          availableCount={availableCount}
          onStart={startFresh}
          onResume={resume}
          onAbandon={abandonSession}
          onRemoveFocus={removeFocus}
        />
      )}

      {phase === 'practice' && session && curLine && (
        <PracticeView
          key={session.startedAt}
          script={script}
          session={session}
          curIdx={curIdx}
          curLine={curLine}
          onRevealOne={onRevealOne}
          onRevealAll={onRevealAll}
          onNext={goNext}
          onExit={() => setShowExit(true)}
        />
      )}

      {phase === 'practice' && session && !curLine && (
        // 续练的会话可能已经全部判过
        <ReportView script={script} rec={rec} session={session} onFinish={finish} onAgain={again} onContinue={continueRest} timedOut={timedOut} />
      )}

      {phase === 'report' && session && (
        <ReportView script={script} rec={rec} session={session} onFinish={finish} onAgain={again} onContinue={continueRest} timedOut={timedOut} />
      )}

      {showExit && (
        <div className="modal" data-testid="recite-exit-modal">
          <div className="modal-box">
            <h3>退出练习？</h3>
            <p className="muted">连着两次想不起来的句子已自动加入重点清单。要不要把这份清单留下？</p>
            <p className="muted">无论选哪个，本轮进度都会保留，下次可从当前这句接着练。</p>
            <div className="form-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" data-testid="recite-exit-cancel" onClick={() => setShowExit(false)}>继续练习</button>
              <button className="btn btn-danger" data-testid="recite-exit-discard" onClick={exitDiscard}>
                <Trash2 size={14} /> 不保留重点
              </button>
              <button className="btn" data-testid="recite-exit-keep" onClick={exitKeep}>
                <Flag size={14} /> 保留重点并退出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ================= 配置页 ================= */

interface SetupProps {
  script: Script
  rec: ReciteState
  session: ReciteSession | null
  segmentId: string
  setSegmentId: (v: string) => void
  focusOnly: boolean
  setFocusOnly: (v: boolean) => void
  mode: ReciteMaskMode
  setMode: (m: ReciteMaskMode) => void
  ratio: number
  setRatio: (n: number) => void
  durationMin: number
  setDurationMin: (n: number) => void
  availableCount: number
  onStart: () => void
  onResume: () => void
  onAbandon: () => void
  onRemoveFocus: (id: string) => void
}

function SetupView(p: SetupProps) {
  const { script, rec } = p
  const lineById = useMemo(() => new Map(script.lines.map((l) => [l.id, l])), [script])
  const resumeDone = p.session ? p.session.lines.filter((l) => l.status !== 'none').length : 0

  return (
    <>
      {p.session && (
        <section className="panel recite-resume" data-testid="recite-resume">
          <h2><Play size={15} /> 上次练到一半</h2>
          <p className="muted">
            {MODE_LABELS.find((m) => m.key === p.session!.maskMode)?.label} ·
            进度 {resumeDone}/{p.session.lines.length} 句
            {p.session.focusOnly ? ' · 只练重点清单' : ''}
            {p.session.remainingSec !== null && p.session.remainingSec > 0 && ` · 剩余 ${fmtTime(p.session.remainingSec)}`}
          </p>
          <div className="form-row">
            <button className="btn" data-testid="recite-resume" onClick={p.onResume}>接着这一句练</button>
            <button className="btn btn-ghost btn-danger" data-testid="recite-abandon" onClick={p.onAbandon}>
              <X size={14} /> 放弃本轮
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>练习设置</h2>

        <div className="set-row">
          <span>唱段</span>
          <select data-testid="recite-segment" value={p.segmentId} onChange={(e) => p.setSegmentId(e.target.value)}>
            <option value="">全剧（{script.lines.length} 句）</option>
            {script.segments.map((s) => (
              <option key={s.id} value={s.id}>{s.title}（{s.lineIds.length} 句）</option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <span>遮字方式</span>
          <div className="seg-chips" data-testid="recite-modes">
            {MODE_LABELS.map((m) => (
              <button
                key={m.key}
                className={`chip${p.mode === m.key ? ' active' : ''}`}
                data-testid={`recite-mode-${m.key}`}
                title={m.hint}
                onClick={() => p.setMode(m.key)}
              >{m.label}</button>
            ))}
          </div>
        </div>

        {p.mode !== 'tail' && (
          <div className="set-row">
            <span>{p.mode === 'random' ? '抽句比例' : '遮字比例'}</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.1}
              value={p.ratio}
              data-testid="recite-ratio"
              onChange={(e) => p.setRatio(Number(e.target.value))}
            />
            <b className="recite-ratio-num" data-testid="recite-ratio-value">{Math.round(p.ratio * 100)}%</b>
          </div>
        )}

        <div className="set-row">
          <span><Timer size={13} /> 练习时长</span>
          <select data-testid="recite-duration" value={p.durationMin} onChange={(e) => p.setDurationMin(Number(e.target.value))}>
            {DURATION_OPTIONS.map((m) => (
              <option key={m} value={m}>{m === 0 ? '不限时' : `${m} 分钟`}</option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <span>练习范围</span>
          <label className="chk">
            <input
              type="checkbox"
              data-testid="recite-focus-only"
              checked={p.focusOnly}
              disabled={rec.focusIds.length === 0}
              onChange={(e) => p.setFocusOnly(e.target.checked)}
            />
            只练重点清单（{rec.focusIds.length} 句连着两次想不起来）
          </label>
        </div>

        <p className="muted recite-hint">
          {p.availableCount > 0
            ? `本轮共 ${p.availableCount} 句。方块点一下露一个字，点句子空白处可一次全露。`
            : '当前范围没有可练的句。'}
        </p>
        <div className="form-row">
          <button className="btn" data-testid="recite-start" disabled={p.availableCount === 0 || !!p.session} onClick={p.onStart}>
            <Brain size={15} /> {p.focusOnly ? '只练重点清单' : '开始默记'}
          </button>
          {p.session && <span className="muted">先「接着练」或「放弃本轮」再开新一轮</span>}
        </div>
      </section>

      <section className="panel" data-testid="recite-focus-panel">
        <h2><Flag size={15} /> 重点清单（{rec.focusIds.length}）</h2>
        {rec.focusIds.length === 0 && (
          <p className="muted" data-testid="recite-focus-empty">还没有重点句。练习时连着两次想不起来的句子会自动进到这里。</p>
        )}
        <div className="card-list">
          {rec.focusIds.map((fid) => {
            const line = lineById.get(fid)
            if (!line) return null
            return (
              <div className="card" key={fid} data-testid="recite-focus-item">
                <div className="card-main">
                  <div className="card-title recite-focus-text">{line.role ? `${line.role}：` : ''}{line.text}</div>
                  <div className="card-sub muted">连续想不起来 {rec.streaks[fid] ?? 0} 次</div>
                </div>
                <div className="card-actions">
                  <button
                    className="btn btn-small btn-ghost"
                    data-testid="recite-focus-remove"
                    title="已记住，移出清单"
                    onClick={() => p.onRemoveFocus(fid)}
                  ><X size={13} /> 记住了</button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}

/* ================= 练习页 ================= */

interface PracticeProps {
  script: Script
  session: ReciteSession
  curIdx: number
  curLine: ReciteSessionLine
  onRevealOne: (i: number) => void
  onRevealAll: () => void
  onNext: () => void
  onExit: () => void
}

function PracticeView(p: PracticeProps) {
  const { script, session, curIdx, curLine } = p
  const line = script.lines.find((l) => l.id === curLine.id)!

  const practiced = session.lines.filter((l) => l.status !== 'none').length
  const peekCount = curLine.revealed.length
  const maskTotal = curLine.masked.filter(Boolean).length
  const segOf = script.segments.find((s) => s.lineIds.includes(line.id))

  return (
    <div data-testid="recite-practice">
      <div className="recite-pbar panel">
        <button className="btn btn-ghost btn-small" data-testid="recite-exit" onClick={p.onExit}>
          <X size={14} /> 退出
        </button>
        <span className="recite-progress" data-testid="recite-progress">
          第 {curIdx + 1} / {session.lines.length} 句 · 已练 {practiced}
        </span>
        <span className="recite-segname muted">{segOf ? segOf.title : ''}</span>
        {session.remainingSec !== null && (
          <span className="recite-timer" data-testid="recite-timer" data-low={session.remainingSec <= 30 || undefined}>
            <Timer size={13} /> {fmtTime(session.remainingSec)}
          </span>
        )}
      </div>

      <div
        className="recite-card panel"
        data-testid="recite-line-card"
        data-peeked={peekCount > 0 || undefined}
        onClick={(e) => {
          // 点句子空白处或明字区域（方块自身 stopPropagation）= 整句全露
          if (e.target === e.currentTarget || !!(e.target as HTMLElement).closest('.recite-chars')) p.onRevealAll()
        }}
      >
        {line.role && <div className="recite-role">{line.role}</div>}
        <div className="recite-chars">{renderChars(line.text, curLine, p.onRevealOne)}</div>
        {line.note && <div className="recite-note muted">批注：{line.note}</div>}
        <div className="recite-peek-tip" data-testid="recite-peek-state">
          {peekCount === 0
            ? maskTotal > 0
              ? '心里默念，对了就直接「下一句（全对）」；忘了就点方块'
              : '这句本轮没有要考的字（直接过，不计成绩）'
            : `已看 ${peekCount} 个字（本句将记为「看了一眼」）`}
        </div>
      </div>

      <div className="form-row recite-actions">
        <button className="btn btn-ghost" data-testid="recite-reveal-all" onClick={p.onRevealAll} disabled={peekCount >= maskTotal}>
          <Eye size={15} /> 整句露出
        </button>
        <button className="btn" data-testid="recite-next" onClick={p.onNext}>
          {curIdx + 1 >= session.lines.length ? '完成本轮' : '下一句'}
          {peekCount === 0 && maskTotal > 0 ? '（全对）' : ''}
        </button>
      </div>
    </div>
  )
}

/* ================= 报告页 ================= */

interface ReportProps {
  script: Script
  rec: ReciteState
  session: ReciteSession
  timedOut?: boolean
  onFinish: (keep: boolean) => void
  onAgain: () => void
  onContinue: () => void
}

function ReportView({ script, rec, session, timedOut, onFinish, onAgain, onContinue }: ReportProps) {
  const lineById = useMemo(() => new Map(script.lines.map((l) => [l.id, l])), [script])
  const stats = summarize(session, rec.focusIds, session.focusSnapshot)
  const newFocus = new Set(stats.newFocusIds)
  const remaining = session.lines.filter((l) => l.status === 'none').length

  return (
    <div data-testid="recite-report">
      <section className="panel">
        <h2>{timedOut ? '时间到，本轮小结' : '本轮练习小结'}</h2>
        <div className="recite-stats">
          <span className="recite-stat perfect"><b>{stats.perfect}</b> 一次没错</span>
          <span className="recite-stat peeked"><b>{stats.peeked}</b> 看了一眼才想起</span>
          <span className="recite-stat muted"><b>{remaining}</b> 还没练到</span>
          {stats.skipped > 0 && <span className="recite-stat muted"><b>{stats.skipped}</b> 本轮没考</span>}
          <span className="recite-stat focus"><b>{stats.newFocusIds.length}</b> 句新进重点清单</span>
        </div>
        {remaining > 0 && <p className="muted">没练完的句仍保留进度，可「接着练剩下的」继续。</p>}
      </section>

      <section className="panel">
        <h2>按句结果</h2>
        <div className="recite-report-list">
          {session.lines.map((sl, i) => {
            const line = lineById.get(sl.id)
            if (!line) return null
            return (
              <div
                key={sl.id}
                className={`recite-report-line ${sl.status}`}
                data-testid="recite-report-line"
                data-status={sl.status}
                data-new-focus={newFocus.has(sl.id) || undefined}
              >
                <span className="recite-report-no">{i + 1}</span>
                <StatusBadge status={sl.status} />
                <span className="recite-report-text">
                  {line.role ? <em className="recite-role-sm">{line.role}：</em> : null}{line.text}
                </span>
                {newFocus.has(sl.id) && <Flag size={14} className="recite-focus-flag" aria-label="新进重点" />}
              </div>
            )
          })}
        </div>
      </section>

      <section className="panel">
        <h2>重点清单（{rec.focusIds.length}）</h2>
        {rec.focusIds.length === 0 && <p className="muted">本轮没有句子进重点清单。</p>}
        <ul className="recite-focus-now">
          {rec.focusIds.map((fid) => {
            const line = lineById.get(fid)
            return line ? <li key={fid}>{line.role ? `${line.role}：` : ''}{line.text}</li> : null
          })}
        </ul>
      </section>

      <div className="form-row recite-report-actions">
        <button className="btn btn-ghost" data-testid="recite-again" onClick={onAgain}>
          <RotateCcw size={15} /> 同范围再来一轮
        </button>
        {remaining > 0 && (
          <button className="btn btn-ghost" data-testid="recite-continue" onClick={onContinue}>
            <Play size={15} /> 接着练剩下的
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn-danger" data-testid="recite-finish-discard" onClick={() => onFinish(false)}>
          <Trash2 size={14} /> 不保留重点清单
        </button>
        <button className="btn" data-testid="recite-finish-keep" onClick={() => onFinish(true)}>
          <Flag size={14} /> 留下重点清单
        </button>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: ReciteSessionLine['status'] }) {
  if (status === 'perfect') {
    return (
      <span className="recite-badge perfect" data-testid="recite-badge-perfect">
        <EyeOff size={12} /> 一次没错
      </span>
    )
  }
  if (status === 'peeked') {
    return (
      <span className="recite-badge peeked" data-testid="recite-badge-peeked">
        <Eye size={12} /> 看了一眼
      </span>
    )
  }
  if (status === 'skipped') {
    return <span className="recite-badge skipped muted" data-testid="recite-badge-skipped">本轮没考</span>
  }
  return <span className="recite-badge none muted">未练</span>
}

/* ================= 渲染辅助 ================= */

/** 把一句唱词渲染成「方块 + 明字」序列；标点等非可遮字直接显示 */
function renderChars(text: string, sl: ReciteSessionLine, onReveal: (i: number) => void) {
  let maskIdx = -1
  return Array.from(text).map((ch, i) => {
    if (!isMaskable(ch)) {
      return <span className="recite-char plain" key={i}>{ch === ' ' ? ' ' : ch}</span>
    }
    maskIdx += 1
    const hidden = sl.masked[maskIdx]
    const revealed = sl.revealed.includes(maskIdx)
    if (!hidden || revealed) {
      return (
        <span className={`recite-char${revealed ? ' revealed' : ''}`} key={i} data-revealed={revealed || undefined}>
          {ch}
        </span>
      )
    }
    return (
      <button
        type="button"
        className="recite-block"
        key={i}
        data-testid="recite-block"
        data-mask-idx={maskIdx}
        aria-label="点一下露出这个字"
        onClick={(e) => {
          e.stopPropagation()
          onReveal(maskIdx)
        }}
      >
        <span className="recite-block-box" />
      </button>
    )
  })
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
