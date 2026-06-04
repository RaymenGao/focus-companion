export type LearningState =
  | "FOCUSED"
  | "READING"
  | "THINKING"
  | "WRITING"
  | "STALLED"
  | "DISTRACTED"
  | "PAUSED";

export type FrontSignal = {
  state: LearningState;
  reason: string;
  pitchRatio: number | null;
  yawRatio: number | null;
  gazeRatio: number | null;
  paperFocused: boolean;
  absent: boolean;
};

export type WritingSignal = {
  active: boolean;
  motionScore: number;
  lastActiveAt: number | null;
  calibrated: boolean;
};

export type SessionSample = {
  ts: number;
  state: LearningState;
  reason: string;
  motionScore: number;
};

export type AiConfig = {
  provider: string;
  baseUrl: string;
  aiBaseUrl: string;
  apiKey: string;
  model: string;
  captureMode: "full" | "paper";
  captureRegion: { x: number; y: number; width: number; height: number };
  useStreaming: boolean;
  enableThinking: boolean;
  paperFocusMode: "auto" | "manual";
  paperFocusDistance: number;
  singleCallBudgetUsd: number;
  dailyBudgetUsd: number;
  allowImageUpload: boolean;
};

export type TutorProfile = {
  grade: string;
  teacherName: string;
  style: string;
  socraticFirst: boolean;
  allowDirectAnswer: boolean;
  speechVoiceName: string;
  speechRate: number;
  speechPitch: number;
};

export type MistakeEntry = {
  id: string;
  createdAt: string;
  subject: string;
  grade: string;
  knowledgePoint: string;
  mistakeReason: string;
  mastery: number;
  questionText?: string;
  studentQuestion: string;
  answerMarkdown: string;
  imageDataUrl?: string;
};

export type CostSummary = {
  todayCalls: number;
  todayEstimatedUsd: number;
  weekEstimatedUsd: number;
  activeAiCalls: number;
};

export type KnowledgeWiki = {
  knowledgePoint: string;
  subject: string;
  count: number;
  isHot: boolean;
  markdown: string;
  filePath?: string;
};
