import type { AiConfig, MistakeEntry, SessionSample, TutorProfile } from "./types";

const keys = {
  sessions: "focuslens_v2_sessions",
  aiConfig: "focuslens_v2_ai_config",
  tutorProfile: "focuslens_v2_tutor_profile",
  mistakes: "focuslens_v2_mistakes"
};

export const defaultAiConfig: AiConfig = {
  provider: "OpenAI-compatible",
  baseUrl: "http://127.0.0.1:8012",
  aiBaseUrl: "",
  apiKey: "",
  model: "gpt-4o-mini",
  captureMode: "paper",
  captureRegion: { x: 0.12, y: 0.18, width: 0.76, height: 0.68 },
  useStreaming: true,
  enableThinking: false,
  paperFocusMode: "auto",
  paperFocusDistance: 0.8,
  singleCallBudgetUsd: 0.05,
  dailyBudgetUsd: 1,
  allowImageUpload: true
};

export const defaultTutorProfile: TutorProfile = {
  grade: "小学四年级",
  teacherName: "小老师",
  style: "温和、启发式、先问再讲",
  socraticFirst: true,
  allowDirectAnswer: false,
  speechVoiceName: "",
  speechRate: 1.12,
  speechPitch: 1.04
};

function compactMistake(entry: MistakeEntry): MistakeEntry {
  return { ...entry, imageDataUrl: "" };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback)) {
      return (Array.isArray(parsed) ? parsed : fallback) as unknown as T;
    }
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    if (key === keys.mistakes) {
      localStorage.removeItem(keys.mistakes);
    }
  }
}

export function compactMistakesForCache(entries: MistakeEntry[]) {
  return entries.map(compactMistake).slice(0, 100);
}

export function cacheMistakes(entries: MistakeEntry[]) {
  writeJson(keys.mistakes, compactMistakesForCache(entries));
}

export function loadAiConfig() {
  const config = readJson(keys.aiConfig, defaultAiConfig);
  const localBackend = defaultAiConfig.baseUrl;

  if (config.baseUrl.includes(":8000") || config.baseUrl.includes(":8010")) {
    config.baseUrl = localBackend;
  }

  const isLocal = config.baseUrl.includes("127.0.0.1") || config.baseUrl.includes("localhost");
  if (!isLocal) {
    if (!config.aiBaseUrl) {
      config.aiBaseUrl = config.baseUrl;
    }
    config.baseUrl = localBackend;
    writeJson(keys.aiConfig, config);
  }

  if (!config.captureMode) {
    config.captureMode = "paper";
  }
  if (!config.captureRegion) {
    config.captureRegion = defaultAiConfig.captureRegion;
  }
  if (typeof config.useStreaming !== "boolean") {
    config.useStreaming = true;
  }
  if (typeof config.enableThinking !== "boolean") {
    config.enableThinking = false;
  }
  if (config.paperFocusMode !== "manual" && config.paperFocusMode !== "auto") {
    config.paperFocusMode = "auto";
  }
  if (typeof config.paperFocusDistance !== "number") {
    config.paperFocusDistance = 0.8;
  }

  return config;
}

export function saveAiConfig(config: AiConfig) {
  writeJson(keys.aiConfig, config);
}

export function loadTutorProfile() {
  return readJson(keys.tutorProfile, defaultTutorProfile);
}

export function saveTutorProfile(profile: TutorProfile) {
  writeJson(keys.tutorProfile, profile);
}

export function saveSession(samples: SessionSample[]) {
  const sessions = readJson<SessionSample[][]>(keys.sessions, []);
  sessions.push(samples);
  writeJson(keys.sessions, sessions.slice(-100));
}

export function loadSessions() {
  return readJson<SessionSample[][]>(keys.sessions, []);
}

export function loadMistakes() {
  const mistakes = readJson<MistakeEntry[]>(keys.mistakes, []);
  if (mistakes.some((entry) => entry.imageDataUrl)) {
    cacheMistakes(mistakes);
  }
  return compactMistakesForCache(mistakes);
}

export function saveMistake(entry: MistakeEntry) {
  const mistakes = loadMistakes();
  mistakes.unshift(compactMistake(entry));
  writeJson(keys.mistakes, mistakes.slice(0, 100));
}

export function deleteMistakeLocal(id: string) {
  const mistakes = loadMistakes().filter((item) => item.id !== id);
  writeJson(keys.mistakes, mistakes);
}

export function updateMistake(entry: MistakeEntry) {
  const mistakes = loadMistakes().map((item) => (item.id === entry.id ? compactMistake(entry) : item));
  writeJson(keys.mistakes, mistakes);
}
