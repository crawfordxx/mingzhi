/** 单个识别单元（中文为单字，英文为子词），时间为原片绝对秒数 */
export interface Token { text: string; start: number; end: number }
export interface SpeechSegment { start: number; end: number }
export interface Transcript { durationSec: number; segments: SpeechSegment[]; tokens: Token[] }
