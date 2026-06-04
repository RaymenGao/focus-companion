import type { FrontSignal, LearningState, SessionSample, WritingSignal } from "./types";

export type FusionSettings = {
  readingGraceMs: number;
  thinkingGraceMs: number;
  stalledCareMs: number;
};

export const defaultFusionSettings: FusionSettings = {
  readingGraceMs: 45000,
  thinkingGraceMs: 90000,
  stalledCareMs: 120000
};

export type FusedState = {
  state: LearningState;
  reason: string;
  shouldOfferCare: boolean;
};

let paperStillStartAt: number | null = null;
let lastCareOfferAt = 0;

export function fuseSignals(
  front: FrontSignal,
  writing: WritingSignal,
  paused: boolean,
  settings: FusionSettings = defaultFusionSettings
): FusedState {
  if (paused) return { state: "PAUSED", reason: "已暂停", shouldOfferCare: false };
  if (front.state === "DISTRACTED") {
    paperStillStartAt = null;
    return { state: "DISTRACTED", reason: front.reason, shouldOfferCare: false };
  }
  if (front.paperFocused && writing.active) {
    paperStillStartAt = null;
    return { state: "WRITING", reason: "低头且卷面有书写变化", shouldOfferCare: false };
  }
  if (!front.paperFocused) {
    paperStillStartAt = null;
    return { state: "FOCUSED", reason: front.reason, shouldOfferCare: false };
  }

  const now = Date.now();
  if (!paperStillStartAt) paperStillStartAt = now;
  const stillMs = now - paperStillStartAt;
  if (stillMs < settings.readingGraceMs) {
    return { state: "READING", reason: "低头无书写，处于阅读宽限期", shouldOfferCare: false };
  }
  if (stillMs < settings.thinkingGraceMs) {
    return { state: "THINKING", reason: "可能正在思考难题", shouldOfferCare: false };
  }

  const shouldOfferCare = stillMs > settings.stalledCareMs && now - lastCareOfferAt > settings.stalledCareMs;
  if (shouldOfferCare) lastCareOfferAt = now;
  return { state: "STALLED", reason: "长时间没有书写变化", shouldOfferCare };
}

export function summarizeSession(samples: SessionSample[]) {
  const counts = samples.reduce<Record<LearningState, number>>(
    (acc, sample) => {
      acc[sample.state] += 1;
      return acc;
    },
    { FOCUSED: 0, READING: 0, THINKING: 0, WRITING: 0, STALLED: 0, DISTRACTED: 0, PAUSED: 0 }
  );
  const active = Math.max(samples.length - counts.PAUSED, 1);
  const productive = counts.FOCUSED + counts.READING + counts.THINKING + counts.WRITING;
  const score = Math.max(10, Math.min(100, Math.round((productive / active) * 100 - counts.DISTRACTED * 2 - counts.STALLED)));
  return { counts, score, durationSec: samples.length };
}
