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
  useBackendAsr: boolean;
  useBackendTts: boolean;
  ttsMode: "browser" | "edge-tts" | "cloud";
  edgeTtsVoice: string;
  asrBaseUrl: string;
  asrApiKey: string;
  asrModel: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
  ttsInstruct: string;
  ttsLanguage: string;
  paperFocusMode: "auto" | "manual";
  paperFocusDistance: number;
  singleCallBudgetUsd: number;
  dailyBudgetUsd: number;
  allowImageUpload: boolean;
  allowInsecureAiTls: boolean;
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
  correctAnswerMarkdown?: string;
  chapter?: string;
  prerequisites?: string[];
  wikiPageId?: string;
  imageDataUrl?: string;
};

export type LearningEventFollowUp = {
  askedAt: string;
  question: string;
  answerMarkdown: string;
};

export type LearningEvent = {
  id: string;
  interactionMode: "vision" | "voice" | "followup";
  eventType: "wrong" | "stuck" | "question" | "review";
  classificationConfidence: number;
  subject: string;
  chapter: string;
  grade: string;
  createdAt: string;
  updatedAt: string;
  writeStatus: "draft" | "complete" | "pending_save" | "archived";
  originalQuestion: string;
  questionText: string;
  questionImage: string;
  questionImageMissing: boolean;
  reasoningMarkdown: string;
  finalAnswerMarkdown: string;
  answerRevealed: boolean;
  answerRevealedAt: string;
  knowledgeSuggestions: string[];
  relatedKnowledge: string[];
  mistakeReason: string;
  masterySuggestion: number;
  followUps: LearningEventFollowUp[];
};

export type CostSummary = {
  todayCalls: number;
  todayEstimatedUsd: number;
  weekEstimatedUsd: number;
  activeAiCalls: number;
};

export type ParentAiTeacherMode = "enabled" | "ask_parent" | "disabled";

export type ParentSettings = {
  aiTeacherMode: ParentAiTeacherMode;
  driftReminderEnabled: boolean;
  idleReminderEnabled: boolean;
  absentReminderEnabled: boolean;
  longIdleMinutes: number;
  aiApprovedQuestionId?: string;
  aiApprovalAction?: string;
};

export type ParentStudentStatus = {
  learningState: string;
  reason: string;
  writingActive: boolean;
  absent: boolean;
  aiBusy: boolean;
  activeTab: string;
  lastLearningAt: string;
  updatedAt: string;
  samples?: SessionSample[];
  pendingQuestionId?: string;
  pendingQuestionText?: string;
  aiApprovalStatus?: string;
};

export type ParentReminder = {
  id: string;
  type: "focus" | "idle" | "absent" | "custom";
  message: string;
  createdAt: string;
  delivered: boolean;
};

export type ParentState = {
  settings: ParentSettings;
  student: ParentStudentStatus;
  reminders: ParentReminder[];
  pairingCode: string;
  updatedAt: string;
};

export type KnowledgeWiki = {
  knowledgePoint: string;
  subject: string;
  count: number;
  isHot: boolean;
  markdown: string;
  filePath?: string;
};

export type WikiPageSummary = {
  id: string;
  title: string;
  type: "index" | "subject" | "chapter" | "knowledge" | "mistake" | "lint" | "query" | "flashcards" | "report" | "page";
  subject: string;
  chapter: string;
  knowledgePoint: string;
  status: "" | "weak" | "learning" | "mastered" | "ignored";
  path: string;
  updatedAt: string;
};

export type WikiPage = WikiPageSummary & {
  markdown: string;
};

export type WikiGraphNode = {
  id: string;
  label: string;
  type: "subject" | "chapter" | "knowledge" | "mistake" | "reason" | "prerequisite";
  subject: string;
  chapter: string;
  mistakeCount: number;
  avgMastery: number;
  weaknessScore: number;
  hot: boolean;
  lastSeenAt: string;
  pageId?: string;
};

export type WikiGraphEdge = {
  source: string;
  target: string;
  type: "contains" | "related_to" | "caused_by" | "reinforces" | "prerequisite_of" | "repeated_with";
  weight: number;
  confidence: "extracted" | "inferred" | "ambiguous";
};

export type WikiGraphSummary = {
  topWeakNodes: WikiGraphNode[];
  prerequisiteGaps: WikiGraphNode[];
  repeatedReasons: WikiGraphNode[];
  subjectCoverage: Array<{ subject: string; mistakeCount: number; avgMastery: number; chapters: number }>;
};

export type WikiGraphResponse = {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  summary: WikiGraphSummary;
};

export type WikiActionRequest = {
  action: "lint" | "query" | "flashcards" | "report";
  subject: string;
  knowledgePoint: string;
  dateRange: string;
  difficulty: string;
  count: number;
  promptTemplate?: string;
  config: AiConfig;
  profile: TutorProfile;
};

export type FlashcardItem = {
  frontMarkdown: string;
  backMarkdown: string;
  knowledgePoint: string;
  sourceMistakeIds: string[];
  masteryTag: string;
};

export type WikiActionResponse = {
  markdown: string;
  pageId: string;
  filePath: string;
  estimatedCostUsd: number;
  flashcards: FlashcardItem[];
};
export type { MasteryState, WikiOperation, WikiView } from "./wiki/types";
