export type CueKind = 'pause' | 'interlude' | 'drum' | 'note'

export interface Cue {
  id: string
  kind: CueKind
  seconds?: number
  label?: string
}

export interface Line {
  id: string
  role?: string
  text: string
  cues: Cue[]
  marks: string[]
  note?: string
}

export interface Segment {
  id: string
  title: string
  lineIds: string[]
  loop?: boolean
}

export type ScriptStyle = 'opera' | 'speech'

export interface Script {
  id: string
  title: string
  troupe?: string
  lines: Line[]
  segments: Segment[]
  style: ScriptStyle
  updatedAt: number
}

export type ThemeName = 'dark' | 'light' | 'highContrast'

export interface PromptSettings {
  fontSizePx: number
  autoFit: boolean
  autoScroll: boolean
  speedPxPerSec: number
  theme: ThemeName
  holdOnCue: boolean
  lockStage: boolean
}

/* ============ 默记练习 ============ */

/** 遮字方式：ratio=按比例随机遮、tail=只遮每句后半截、random=按句随机抽遮 */
export type ReciteMaskMode = 'ratio' | 'tail' | 'random'

/** 单句状态：none=还没练、perfect=一次没错、peeked=看过（点方块/整句露出）、skipped=本轮没遮字（random 未抽中/极短句），中性不计成绩 */
export type ReciteLineStatus = 'none' | 'perfect' | 'peeked' | 'skipped'

export interface ReciteSessionLine {
  /** 句 id（对应 Line.id） */
  id: string
  /** 每个可遮字是否遮住（长度=该句可遮字数，标点不在其中） */
  masked: boolean[]
  status: ReciteLineStatus
  /** 本次练习里已露出的可遮字下标；为空且 status=perfect 即「一次没错」 */
  revealed: number[]
}

/** 进行中的默记练习（中途退出再进来可接着练） */
export interface ReciteSession {
  maskMode: ReciteMaskMode
  /** 遮字比例 0~1（tail 模式不用） */
  ratio: number
  /** 练习时长（分钟），0=不限时 */
  durationMin: number
  /** 剩余秒数；不限时为 null */
  remainingSec: number | null
  /** 参与练习的句 id，按练习顺序 */
  lineIds: string[]
  /** 只练重点清单 */
  focusOnly: boolean
  lines: ReciteSessionLine[]
  /** 进入本次练习时的重点清单快照（退出「不保留」时回滚用） */
  focusSnapshot: string[]
  startedAt: number
}

/** 每个剧目一份的默记状态（IndexedDB store「recite」，key=scriptId） */
export interface ReciteState {
  id: string
  /** 重点清单：连着两次想不起来的句 id */
  focusIds: string[]
  /** 每句「想不起来」的连续次数（一次没错即清零） */
  streaks: Record<string, number>
  /** 未完成的练习；完成并退出后删除 */
  session?: ReciteSession
}
