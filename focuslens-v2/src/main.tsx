import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import {
  AlertCircle,
  Award,
  BookOpen,
  Brain,
  Calendar,
  Camera,
  Clock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Download,
  Eye,
  FileCheck2,
  Folder,
  HelpCircle,
  LayoutDashboard,
  Mic,
  Moon,
  Pause,
  Play,
  Search,
  Settings,
  Square,
  Trash2,
  Volume2,
  WifiOff,
  X
} from "lucide-react";
import { askTutor, askTutorStream, createParentReminder, deleteMistakeRemote, fetchLanAccessInfo, fetchLearningEvents, fetchMistakes, fetchParentReminders, fetchParentStatus, fetchWiki, fetchWikiGraph, fetchWikiPage, fetchWikiPages, getCostSummary, markParentReminderDelivered, promoteLearningEvent, rebuildWiki, reclassifyWikiPage, recognizeMemoTodos, revealLearningEventAnswer, runWikiAction, synthesizeSpeech, synthesizeSpeechEdge, testAiConnection, transcribeSpeech, updateKnowledgeStatus, updateMistakeRemote, updateParentSettings, updateParentStatus } from "./api";
import { renderMathMarkdown } from "./markdown";
import { cacheMistakes, deleteMistakeLocal, saveAiConfig, loadAiConfig, loadTutorProfile, saveTutorProfile, saveSession, loadSessions, saveMistake, loadMistakes, updateMistake } from "./storage";
import { fuseSignals, summarizeSession } from "./stateMachine";
import type { AiConfig, CostSummary, FlashcardItem, FrontSignal, KnowledgeWiki, LearningEvent, LearningState, MistakeEntry, ParentReminder, ParentSettings, ParentState, SessionSample, TutorProfile, WikiActionRequest, WikiGraphNode, WikiGraphResponse, WikiPage, WikiPageSummary, WritingSignal } from "./types";
import { createFaceTracker, defaultVisionThresholds, type VisionThresholds } from "./vision";
import { createWritingDetector } from "./writingDetector";
import { registerServiceWorker } from "./pwa";
import { WikiWorkspace } from "./wiki/WikiWorkspace";
import { InboxView } from "./wiki/InboxView";
import { confirmWikiInboxItem, deleteWikiInboxItem, fetchWikiInbox, fetchWikiPagesV2, fetchWikiTerms, rerunWikiInboxItem } from "./wiki/api";
import { MaterialsView } from "./wiki/MaterialsView";
import type { WikiInboxItem, WikiPageSummaryV2, WikiTerm } from "./wiki/types";
import "./styles.css";

type AppTab = "dashboard" | "calendar" | "monitor" | "tutor" | "settings" | "mistakes" | "wiki" | "materials";

const DEFAULT_SUBJECT_OPTIONS = ["数学", "语文", "英语", "外语", "科学", "历史", "地理", "其他"];
const CUSTOM_SUBJECTS_KEY = "focuslens_v2_custom_subjects";

type DashboardCardId = "focus" | "calendar" | "weakness" | "heatmap" | "weekly" | "costs" | "timeline";
type DashboardCardSize = "small" | "medium" | "large" | "wide";
type DashboardCardConfig = { id: DashboardCardId; size: DashboardCardSize; visible: boolean };
type DashboardTodo = { id: string; text: string; done: boolean };

const dashboardCardLabels: Record<DashboardCardId, string> = {
  focus: "今日专注",
  calendar: "学习日历",
  weakness: "薄弱提醒",
  heatmap: "本月热力图",
  weekly: "一周节奏",
  costs: "AI 费用",
  timeline: "今日时间线"
};

const defaultDashboardLayout: DashboardCardConfig[] = [
  { id: "focus", size: "wide", visible: true },
  { id: "weekly", size: "medium", visible: true },
  { id: "weakness", size: "medium", visible: true },
  { id: "timeline", size: "wide", visible: true },
  { id: "calendar", size: "medium", visible: true },
  { id: "heatmap", size: "medium", visible: true },
  { id: "costs", size: "small", visible: false },
];

type SpeechRecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: { length: number; [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

const initialFront: FrontSignal = {
  state: "FOCUSED",
  reason: "等待摄像头启动",
  pitchRatio: null,
  yawRatio: null,
  gazeRatio: null,
  paperFocused: false,
  absent: false
};

const initialWriting: WritingSignal = {
  active: false,
  motionScore: 0,
  lastActiveAt: null,
  calibrated: false
};

function App() {
  const frontVideoRef = useRef<HTMLVideoElement>(null);
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const paperVideoRef = useRef<HTMLVideoElement>(null);
  const paperCanvasRef = useRef<HTMLCanvasElement>(null);
  const faceTrackerRef = useRef<ReturnType<typeof createFaceTracker> | null>(null);
  const writingDetectorRef = useRef<ReturnType<typeof createWritingDetector> | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const reminderRecorderRef = useRef<MediaRecorder | null>(null);
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastReminderAtRef = useRef(0);
  const speechRunIdRef = useRef(0);
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechKeepAliveRef = useRef<number | null>(null);
  const wakeRecognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const questionRecognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const questionVoiceActiveRef = useRef(false);
  const questionVoiceSubmittedRef = useRef(false);
  const questionVoiceTranscriptRef = useRef("");
  const questionVoiceModeRef = useRef<"new" | "followup">("new");
  const questionListenTimerRef = useRef(0);
  const wakeActiveRef = useRef(false);
  const captureAskRecognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const captureAskTranscriptRef = useRef("");
  const captureAskFallbackTimerRef = useRef(0);
  const captureAskAutoSubmitRef = useRef(false);
  const captureAskActiveRef = useRef(false);
  const captureAskSubmittedRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const thresholdsRef = useRef<VisionThresholds>(defaultVisionThresholds);

  const [tab, setTab] = useState<AppTab>("dashboard");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [frontDeviceId, setFrontDeviceId] = useState("");
  const [paperDeviceId, setPaperDeviceId] = useState("");
  const [thresholds, setThresholds] = useState<VisionThresholds>(defaultVisionThresholds);
  const [frontSignal, setFrontSignal] = useState(initialFront);
  const [writingSignal, setWritingSignal] = useState(initialWriting);
  const [isVisionOn, setVisionOn] = useState(false);
  const [isSessionActive, setSessionActive] = useState(false);
  const [isPaused, setPaused] = useState(false);
  const [isBlackout, setBlackout] = useState(false);
  const [samples, setSamples] = useState<SessionSample[]>([]);
  const [historicalSessions, setHistoricalSessions] = useState<SessionSample[][]>(() => {
    try {
      return loadSessions();
    } catch {
      return [];
    }
  });
  const [careOffer, setCareOffer] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiConfig>(loadAiConfig);
  const [profile, setProfile] = useState<TutorProfile>(loadTutorProfile);
  const [studentQuestion, setStudentQuestion] = useState("");
  const [recording, setRecording] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [wakeStatus, setWakeStatus] = useState("未开启唤醒");
  const [wakeTranscript, setWakeTranscript] = useState("");
  const [tutorAnswer, setTutorAnswer] = useState("");
  const [tutorFinalAnswer, setTutorFinalAnswer] = useState("");
  const [learningEvents, setLearningEvents] = useState<LearningEvent[]>([]);
  const [currentLearningEvent, setCurrentLearningEvent] = useState<LearningEvent | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState("");
  const [mistakes, setMistakes] = useState<MistakeEntry[]>(loadMistakes);
  const [wiki, setWiki] = useState<KnowledgeWiki[]>([]);
  const [wikiPages, setWikiPages] = useState<WikiPageSummary[]>([]);
  const [wikiGraph, setWikiGraph] = useState<WikiGraphResponse | null>(null);
  const [selectedWikiPage, setSelectedWikiPage] = useState<WikiPage | null>(null);
  const [wikiInbox, setWikiInbox] = useState<WikiInboxItem[]>([]);
  const [materialPages, setMaterialPages] = useState<WikiPageSummaryV2[]>([]);
  const [materialTerms, setMaterialTerms] = useState<WikiTerm[]>([]);
  const [materialTermId, setMaterialTermId] = useState("legacy");
  const [wikiBusy, setWikiBusy] = useState("");
  const [wikiActionResult, setWikiActionResult] = useState("");
  const [wikiFlashcards, setWikiFlashcards] = useState<FlashcardItem[]>([]);
  const [parentState, setParentState] = useState<ParentState | null>(null);
  const [parentReminder, setParentReminder] = useState<ParentReminder | null>(null);
  const [showAiDisabledModal, setShowAiDisabledModal] = useState(false);
  const [pendingQuestionRequest, setPendingQuestionRequest] = useState<{ id: string; text: string; captureImage: boolean; interactionMode: "vision" | "voice" | "followup"; targetEventId?: string } | null>(null);
  const [conversationMode, setConversationMode] = useState(true);

  useEffect(() => {
    if (isBlackout || parentReminder || showAiDisabledModal || pendingQuestionRequest) {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    };
  }, [isBlackout, parentReminder, showAiDisabledModal, pendingQuestionRequest]);
  const [speechStatus, setSpeechStatus] = useState("语音待命");
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [costs, setCosts] = useState<CostSummary>({ todayCalls: 0, todayEstimatedUsd: 0, weekEstimatedUsd: 0, activeAiCalls: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderRecording, setReminderRecording] = useState(false);
  const [customReminderUrl, setCustomReminderUrl] = useState("");
  const [bgMusicUrl, setBgMusicUrl] = useState("");
  const [bgMusicPlaying, setBgMusicPlaying] = useState(false);
  const showSearch = tab === "dashboard" || tab === "mistakes" || tab === "wiki" || tab === "materials";
  const isParentConsole = new URLSearchParams(window.location.search).get("parent") === "1";

  const fused = useMemo(() => fuseSignals(frontSignal, writingSignal, isPaused), [frontSignal, writingSignal, isPaused]);
  const summary = useMemo(() => summarizeSession(samples), [samples]);
  const allSamples = useMemo(() => {
    return [...historicalSessions.flat(), ...samples];
  }, [historicalSessions, samples]);

  useEffect(() => {
    thresholdsRef.current = thresholds;
  }, [thresholds]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((all) => {
      const cams = all.filter((device) => device.kind === "videoinput");
      setDevices(cams);
      const preferred = chooseDefaultCameras(cams);
      if (preferred.front) setFrontDeviceId(preferred.front.deviceId);
      if (preferred.paper) setPaperDeviceId(preferred.paper.deviceId);
    });
  }, []);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const loadVoices = () => setSpeechVoices(window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // Fetch costs and mistakes on mount to sync database and local cache
  useEffect(() => {
    refreshCostsAndMistakes();
    fetchLearningEvents(aiConfig.baseUrl).then(setLearningEvents).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshMaterialWorkspace();
  }, [aiConfig.baseUrl, materialTermId]);

  useEffect(() => {
    if (isParentConsole) return;
    const syncParentState = () => {
      const lastLearningAt = samples.length ? new Date(samples[samples.length - 1].ts).toISOString() : "";
      updateParentStatus(aiConfig.baseUrl, {
        learningState: fused.state,
        reason: fused.reason,
        writingActive: writingSignal.active,
        absent: frontSignal.absent,
        aiBusy,
        activeTab: tab,
        lastLearningAt,
        samples: samples.slice(-300),
        pendingQuestionId: pendingQuestionRequest?.id || "",
        pendingQuestionText: pendingQuestionRequest?.text || "",
        aiApprovalStatus: pendingQuestionRequest ? "pending" : "none"
      })
        .then(setParentState)
        .catch(() => undefined);
    };
    syncParentState();
    const timer = window.setInterval(syncParentState, 5000);
    return () => window.clearInterval(timer);
  }, [aiConfig.baseUrl, aiBusy, frontSignal.absent, fused.reason, fused.state, isParentConsole, samples, tab, writingSignal.active, pendingQuestionRequest]);

  const pendingQuestionRequestRef = useRef(pendingQuestionRequest);
  pendingQuestionRequestRef.current = pendingQuestionRequest;

  useEffect(() => {
    if (isParentConsole) return;
    const syncParentControls = async () => {
      try {
        const [state, reminders] = await Promise.all([
          fetchParentStatus(aiConfig.baseUrl),
          fetchParentReminders(aiConfig.baseUrl)
        ]);
        setParentState(state);

        // Check if there is an active question approval request
        if (pendingQuestionRequestRef.current && state.settings) {
          const req = pendingQuestionRequestRef.current;
          if (state.settings.aiApprovedQuestionId === req.id) {
            const action = state.settings.aiApprovalAction;
            setPendingQuestionRequest(null);
            if (action === "approved") {
              // Play a pleasant success bell chime
              try {
                const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
                const playTone = (freq: number, start: number, duration: number) => {
                  const osc = audioCtx.createOscillator();
                  const gain = audioCtx.createGain();
                  osc.frequency.setValueAtTime(freq, audioCtx.currentTime + start);
                  osc.connect(gain);
                  gain.connect(audioCtx.destination);
                  gain.gain.setValueAtTime(0, audioCtx.currentTime + start);
                  gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + start + 0.05);
                  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + start + duration);
                  osc.start(audioCtx.currentTime + start);
                  osc.stop(audioCtx.currentTime + start + duration);
                };
                playTone(523.25, 0, 0.2); // C5
                playTone(659.25, 0.15, 0.2); // E5
                playTone(783.99, 0.3, 0.4); // G5
              } catch {}
              // Proceed with the original request shape after parent approval.
              triggerTutor("manual", req.text, req.captureImage, req.interactionMode, true, req.targetEventId);
            } else if (action === "rejected") {
              // Play a buzzer reject tone
              try {
                const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "sawtooth";
                osc.frequency.value = 220;
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                gain.gain.setValueAtTime(0, audioCtx.currentTime);
                gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
                osc.start(audioCtx.currentTime);
                osc.stop(audioCtx.currentTime + 0.4);
              } catch {}
              alert("家长已拒绝本次 AI 教师使用申请。请继续独立思考！");
            }
          }
        }

        const nextReminder = reminders[0];
        if (nextReminder && nextReminder.id !== parentReminder?.id) {
          setParentReminder(nextReminder);
          playReminder();
        }
      } catch {
        // Parent controls are optional and should not interrupt student study.
      }
    };
    syncParentControls();
    const timer = window.setInterval(syncParentControls, 5000);
    return () => window.clearInterval(timer);
  }, [aiConfig.baseUrl, isParentConsole, parentReminder?.id, pendingQuestionRequest]);

  const fusedRef = useRef(fused);
  fusedRef.current = fused;
  const motionScoreRef = useRef(writingSignal.motionScore);
  motionScoreRef.current = writingSignal.motionScore;

  useEffect(() => {
    if (!isSessionActive) return;
    const timer = window.setInterval(() => {
      const currentFused = fusedRef.current;
      const currentMotionScore = motionScoreRef.current;
      setSamples((prev) => {
        const next = { ts: Date.now(), state: currentFused.state, reason: currentFused.reason, motionScore: currentMotionScore };
        const last = prev[prev.length - 1];
        if (last && last.state === next.state && last.reason === next.reason && Math.abs(last.motionScore - next.motionScore) < 0.5 && next.ts - last.ts < 10000) {
          return prev;
        }
        return [...prev.slice(-4999), next];
      });
      if (currentFused.shouldOfferCare) setCareOffer(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isSessionActive]);

  useEffect(() => {
    if (!isSessionActive || isPaused || !reminderEnabled) return;
    if (fused.state !== "DISTRACTED" && fused.state !== "STALLED") return;
    const playPeriodicReminder = () => {
      const now = Date.now();
      if (now - lastReminderAtRef.current < 15000) return;
      lastReminderAtRef.current = now;
      playReminder();
    };
    playPeriodicReminder();
    const timer = window.setInterval(playPeriodicReminder, 15000);
    return () => window.clearInterval(timer);
  }, [fused.state, isPaused, isSessionActive, reminderEnabled]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitBlackout();

      const aiTeacherMode = parentState?.settings.aiTeacherMode || "enabled";
      const isAiDisabled = aiTeacherMode === "disabled";
      const isTutorKey = event.key === "F8" || event.key === "`" || event.key === "F9" || event.key === "F10";

      if (isTutorKey && isAiDisabled) {
        event.preventDefault();
        setShowAiDisabledModal(true);
        try {
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = "sine";
          osc.frequency.value = 440;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0, audioCtx.currentTime);
          gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
          osc.start(audioCtx.currentTime);
          osc.stop(audioCtx.currentTime + 0.3);
        } catch {}
        return;
      }

      if ((event.key === "F8" || event.key === "`") && !event.repeat) {
        event.preventDefault();
        setTab("tutor");
        startCaptureAskListening();
      }
      if (event.key === "F9" && !event.repeat) {
        event.preventDefault();
        setTab("tutor");
        if (!getFollowupTargetEvent()) {
          setSpeechStatus("还没有可追问的学习事件。请先用 F8 截题求助或 F10 语音提问创建一个问题。");
          return;
        }
        startVoiceListening("followup");
      }
      if (event.key === "F10" && !event.repeat) {
        event.preventDefault();
        setTab("tutor");
        startVoiceListening("new");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "F8" || event.key === "`") {
        event.preventDefault();
        finishCaptureAskListening();
      }
      if (event.key === "F9") {
        event.preventDefault();
        finishFollowUpListening();
      }
      if (event.key === "F10") {
        event.preventDefault();
        finishFollowUpListening();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  useEffect(() => saveAiConfig(aiConfig), [aiConfig]);
  useEffect(() => saveTutorProfile(profile), [profile]);
  useEffect(() => {
    writingDetectorRef.current?.setRegion(aiConfig.captureRegion);
  }, [aiConfig.captureRegion]);
  useEffect(() => {
    writingDetectorRef.current?.setFocus(aiConfig.paperFocusMode, aiConfig.paperFocusDistance);
  }, [aiConfig.paperFocusMode, aiConfig.paperFocusDistance]);

  async function refreshLegacyWiki() {
    try {
      setWiki(await fetchWiki(aiConfig.baseUrl));
    } catch {
      // The new Markdown Wiki does not require the legacy knowledge endpoint.
    }
  }

  async function refreshCostsAndMistakes() {
    try {
      const [remoteCosts, remoteMistakes, remotePages, remoteGraph, remoteInbox] = await Promise.all([
        getCostSummary(aiConfig.baseUrl),
        fetchMistakes(aiConfig.baseUrl),
        fetchWikiPages(aiConfig.baseUrl),
        fetchWikiGraph(aiConfig.baseUrl),
        fetchWikiInbox(aiConfig.baseUrl)
      ]);
      setCosts(remoteCosts);
      setWikiPages(remotePages);
      setWikiGraph(remoteGraph);
      setWikiInbox(remoteInbox);
      refreshLegacyWiki();
      if (remoteMistakes.length) {
        setMistakes(remoteMistakes);
        cacheMistakes(remoteMistakes);
      }
    } catch {
      // Local-first mode remains usable when the backend is offline.
    }
  }

  async function refreshWikiInbox() {
    try {
      setWikiInbox(await fetchWikiInbox(aiConfig.baseUrl));
    } catch (err) {
      setError(err instanceof Error ? err.message : "待确认学习证据读取失败");
    }
  }

  async function refreshMaterialWorkspace() {
    try {
      const [termsResponse, pages] = await Promise.all([
        fetchWikiTerms(aiConfig.baseUrl),
        fetchWikiPagesV2(aiConfig.baseUrl, materialTermId)
      ]);
      const terms = Array.isArray(termsResponse.terms) ? termsResponse.terms : [];
      setMaterialTerms(terms);
      setMaterialPages(pages);
      if (materialTermId === "legacy" && termsResponse.active_term_id) {
        setMaterialTermId(termsResponse.active_term_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "学习材料知识点读取失败");
    }
  }

  async function confirmWikiInboxEvidence(itemId: string) {
    try {
      await confirmWikiInboxItem(aiConfig.baseUrl, itemId);
      await refreshCostsAndMistakes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "待确认学习证据沉淀失败");
    }
  }

  async function deleteWikiInboxEvidence(itemId: string) {
    try {
      await deleteWikiInboxItem(aiConfig.baseUrl, itemId);
      await refreshWikiInbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : "待确认学习证据删除失败");
    }
  }

  async function rerunWikiInboxEvidence(itemId: string, decision: any, lockedFields: string[]) {
    try {
      const response = await rerunWikiInboxItem(aiConfig.baseUrl, itemId, decision, lockedFields);
      await refreshWikiInbox();
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : "待确认学习证据重新分析失败");
      throw err;
    }
  }

  async function openWikiPage(pageId: string) {
    if (!pageId) return;
    setWikiBusy("reading");
    try {
      const page = await fetchWikiPage(aiConfig.baseUrl, pageId);
      setSelectedWikiPage(page);
      setTab("wiki");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wiki 页面读取失败");
    } finally {
      setWikiBusy("");
    }
  }

  async function reclassifySelectedWikiPage(pageId: string, subject: string, chapter: string) {
    setWikiBusy("reclassify");
    try {
      const page = await reclassifyWikiPage(aiConfig.baseUrl, pageId, subject, chapter);
      setSelectedWikiPage(page);
      const [pages, graph] = await Promise.all([fetchWikiPages(aiConfig.baseUrl), fetchWikiGraph(aiConfig.baseUrl)]);
      setWikiPages(pages);
      setWikiGraph(graph);
      refreshLegacyWiki();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wiki 章节调整失败");
    } finally {
      setWikiBusy("");
    }
  }

  async function rebuildWikiData() {
    setWikiBusy("rebuild");
    try {
      const pages = await rebuildWiki(aiConfig.baseUrl);
      const remoteGraph = await fetchWikiGraph(aiConfig.baseUrl);
      setWikiPages(pages);
      setWikiGraph(remoteGraph);
      refreshLegacyWiki();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wiki 重建失败");
    } finally {
      setWikiBusy("");
    }
  }

  async function runWikiTool(request: Omit<WikiActionRequest, "config" | "profile">) {
    setWikiBusy(request.action);
    setWikiActionResult("");
    if (request.action !== "flashcards") setWikiFlashcards([]);
    try {
      const response = await runWikiAction({ ...request, config: aiConfig, profile });
      setWikiActionResult(response.markdown);
      setWikiFlashcards(response.flashcards || []);
      const [pages, graph] = await Promise.all([fetchWikiPages(aiConfig.baseUrl), fetchWikiGraph(aiConfig.baseUrl)]);
      setWikiPages(pages);
      setWikiGraph(graph);
      refreshLegacyWiki();
      await openWikiPage(response.pageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wiki AI 操作失败");
    } finally {
      setWikiBusy("");
    }
  }

  function getFollowupTargetEvent(preferredEventId = "") {
    if (preferredEventId) {
      const explicit = [currentLearningEvent, ...learningEvents].find((event) => event?.id === preferredEventId);
      if (explicit) return explicit;
    }
    return currentLearningEvent || learningEvents[0] || null;
  }

  async function startVision() {
    setError("");
    try {
      if (frontVideoRef.current && frontCanvasRef.current) {
        faceTrackerRef.current = createFaceTracker(
          frontVideoRef.current,
          frontCanvasRef.current,
          setFrontSignal,
          frontDeviceId || undefined,
          () => thresholdsRef.current
        );
        await faceTrackerRef.current.start();
      }
      if (paperVideoRef.current && paperCanvasRef.current && paperDeviceId) {
        writingDetectorRef.current = createWritingDetector(
          paperVideoRef.current,
          paperCanvasRef.current,
          setWritingSignal,
          paperDeviceId,
          aiConfig.captureRegion,
          aiConfig.paperFocusMode,
          aiConfig.paperFocusDistance
        );
        await writingDetectorRef.current.start();
      }
      setVisionOn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "摄像头启动失败");
    }
  }

  function stopVision() {
    faceTrackerRef.current?.stop();
    writingDetectorRef.current?.stop();
    setVisionOn(false);
  }

  function startSession() {
    setSamples([]);
    setSessionActive(true);
    setPaused(false);
  }

  function stopSession() {
    setSessionActive(false);
    setPaused(false);
    if (samples.length > 0) {
      saveSession(samples);
      setHistoricalSessions((prev) => [...prev.slice(-99), samples]);
    }
  }

  async function playReminder() {
    try {
      if (customReminderUrl) {
        const audio = new Audio(customReminderUrl);
        audio.volume = 0.85;
        await audio.play();
        return;
      }
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const ctx = new AudioContextCtor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.48);
      window.setTimeout(() => ctx.close(), 700);
    } catch {
      // Browser autoplay policy can block sound until the user interacts.
    }
  }

  async function toggleReminderRecording() {
    if (reminderRecording) {
      reminderRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream);
      reminderRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        if (customReminderUrl) URL.revokeObjectURL(customReminderUrl);
        setCustomReminderUrl(URL.createObjectURL(blob));
        setReminderRecording(false);
      };
      recorder.start();
      setReminderRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法录制提醒音");
      setReminderRecording(false);
    }
  }

  function clearCustomReminder() {
    if (customReminderUrl) URL.revokeObjectURL(customReminderUrl);
    setCustomReminderUrl("");
  }

  async function enterBlackout() {
    setBlackout(true);
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen can be blocked by browser permissions; the fixed overlay remains as fallback.
    }
  }

  async function exitBlackout() {
    setBlackout(false);
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore browser fullscreen exit failures.
    }
  }

  async function toggleBgMusic() {
    if (!bgMusicUrl) {
      setError("请先选择背景音乐文件");
      return;
    }
    if (!bgMusicRef.current) {
      bgMusicRef.current = new Audio(bgMusicUrl);
      bgMusicRef.current.loop = true;
      bgMusicRef.current.volume = 0.28;
    }
    if (bgMusicPlaying) {
      bgMusicRef.current.pause();
      setBgMusicPlaying(false);
      return;
    }
    try {
      bgMusicRef.current.src = bgMusicUrl;
      await bgMusicRef.current.play();
      setBgMusicPlaying(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "背景音乐播放失败");
    }
  }

  function startWakeListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("当前浏览器不支持本地语音唤醒，请先用 F8 或蓝牙按键触发。");
      setWakeStatus("浏览器不支持语音唤醒");
      return;
    }
    if (wakeListening) {
      wakeRecognitionRef.current?.abort();
      wakeRecognitionRef.current = null;
      wakeActiveRef.current = false;
      setWakeListening(false);
      setWakeStatus("已停止唤醒");
      return;
    }

    wakeActiveRef.current = true;
    setWakeListening(true);
    setWakeStatus(`正在听，喊“${profile.teacherName || "小老师"}”即可唤醒`);
    beginWakeRound(SpeechRecognition);
  }

  function beginWakeRound(SpeechRecognition: SpeechRecognitionCtor) {
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[event.resultIndex]?.[0]?.transcript || "";
      const normalized = normalizeSpeech(transcript);
      const teacherName = profile.teacherName.trim() || "小老师";
      const normalizedName = normalizeSpeech(teacherName);
      setWakeTranscript(transcript || "未识别到清晰语音");
      setWakeStatus(transcript ? `听到：${transcript}` : "听到了声音，但没有识别成文字");

      const nameIndex = normalized.indexOf(normalizedName);
      const fallbackIndex = normalized.indexOf("老师");
      const hitIndex = nameIndex >= 0 ? nameIndex + normalizedName.length : fallbackIndex >= 0 ? fallbackIndex + 2 : -1;
      if (hitIndex < 0) return;

      const cleaned = normalized.slice(hitIndex) || "请看我手指的这道题";
      const question = cleaned.includes("这") || cleaned.includes("题") ? cleaned : `请看我手指的这道题。${cleaned}`;
      setWakeStatus("已唤醒，正在截取题目并请求 AI 教师");
      setTab("tutor");
      setStudentQuestion(question);
      triggerTutor("manual", question);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech") {
        setWakeStatus(`没听清，继续听"${profile.teacherName || "小老师"}"`);
        return;
      }
      if (event.error === "network" || event.error === "not-allowed" || event.error === "service-not-allowed") {
        wakeActiveRef.current = false;
        setWakeListening(false);
        setWakeStatus("语音服务不可用，请用按键或按钮触发");
        setError("语音识别服务无法连接（浏览器语音服务在国内可能不可用）。请直接按 F8 或点击上方「截题并求助」按钮。");
        return;
      }
      setWakeStatus(`语音唤醒失败：${event.error}`);
      setError(`语音唤醒失败：${event.error}`);
    };
    recognition.onend = () => {
      if (!wakeActiveRef.current) return;
      window.setTimeout(() => {
        if (wakeActiveRef.current) beginWakeRound(SpeechRecognition);
      }, 250);
    };
    wakeRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (err) {
      wakeActiveRef.current = false;
      setWakeListening(false);
      setWakeStatus(err instanceof Error ? err.message : "语音唤醒启动失败");
    }
  }

  async function recordQuestion() {
    startVoiceListening("new");
  }

  function startCaptureAskListening() {
    if (aiBusy || captureAskActiveRef.current) return;
    setError("");
    setTab("tutor");
    setStudentQuestion("");
    setWakeTranscript("");

    const sessionId = Date.now();
    voiceSessionIdRef.current = sessionId;

    if (questionRecognitionRef.current) {
      try { questionRecognitionRef.current.abort(); } catch {}
      questionRecognitionRef.current = null;
    }
    if (audioRecorderRef.current) {
      try { audioRecorderRef.current.stop(); } catch {}
      audioRecorderRef.current = null;
    }
    questionVoiceActiveRef.current = false;
    questionVoiceSubmittedRef.current = true;

    captureAskTranscriptRef.current = "";
    captureAskActiveRef.current = true;
    captureAskSubmittedRef.current = false;
    window.clearTimeout(captureAskFallbackTimerRef.current);

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setRecording(true);
      setSpeechStatus("当前浏览器不能实时识别语音。请按住 F8，松开后会按纯截图求助发送。");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    captureAskAutoSubmitRef.current = false;
    setRecording(true);
    setSpeechStatus("正在听题号/疑问。请按住不放，看到文字出现后再松开。");
    setSpeechStatus("按住 F8 或按钮说题号/疑问，松开后截图求助");
    recognition.onresult = (event) => {
      if (voiceSessionIdRef.current !== sessionId) return;
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i]?.[0]?.transcript || "";
      }
      if (transcript.trim()) {
        captureAskTranscriptRef.current = transcript.trim();
        setWakeTranscript(transcript.trim());
        setStudentQuestion(transcript.trim());
        setSpeechStatus(`已听到：${transcript.trim()}`);
      }
    };
    recognition.onerror = (event) => {
      if (voiceSessionIdRef.current !== sessionId) return;
      if (event.error === "no-speech") {
        setSpeechStatus("暂时没有听到清楚语音；继续按住说话，或松开后按纯截图求助发送。");
        return;
      }
      captureAskRecognitionRef.current = null;
      if (!captureAskActiveRef.current) setRecording(false);
      setSpeechStatus(`语音识别暂时不可用：${event.error}。松开后仍可按纯截图求助发送。`);
    };
    recognition.onend = () => {
      if (voiceSessionIdRef.current !== sessionId) return;
      captureAskRecognitionRef.current = null;
      if (captureAskActiveRef.current && !captureAskAutoSubmitRef.current) {
        setSpeechStatus("仍在按住 F8，正在继续监听语音...");
        window.setTimeout(() => {
          if (voiceSessionIdRef.current !== sessionId) return;
          if (!captureAskActiveRef.current || captureAskRecognitionRef.current) return;
          captureAskRecognitionRef.current = recognition;
          try {
            recognition.start();
          } catch {
            captureAskRecognitionRef.current = null;
          }
        }, 180);
        return;
      }
      submitCaptureAsk(sessionId);
    };
    captureAskRecognitionRef.current = recognition;
    try {
      recognition.start();
      captureAskFallbackTimerRef.current = window.setTimeout(() => finishCaptureAskListening(), 20000);
    } catch {
      captureAskRecognitionRef.current = null;
      setSpeechStatus("浏览器语音识别启动失败。松开后仍可按纯截图求助发送。");
    }
  }

  function submitCaptureAsk(sessionId?: number) {
    if (sessionId && voiceSessionIdRef.current !== sessionId) return;
    if (captureAskSubmittedRef.current) return;
    captureAskSubmittedRef.current = true;
    captureAskActiveRef.current = false;
    captureAskRecognitionRef.current = null;
    setRecording(false);
    window.clearTimeout(captureAskFallbackTimerRef.current);
    const transcript = captureAskTranscriptRef.current.trim();
    setSpeechStatus(transcript ? `已听到：${transcript}，正在截图并发送。` : "未检测到语音，正在按纯截图求助发送。");
    triggerTutor("manual", transcript || undefined, true);
  }

  function finishCaptureAskListening() {
    window.clearTimeout(captureAskFallbackTimerRef.current);
    if (!captureAskActiveRef.current) return;
    captureAskActiveRef.current = false;
    const recognition = captureAskRecognitionRef.current;
    captureAskAutoSubmitRef.current = true;
    if (!recognition) {
      submitCaptureAsk(voiceSessionIdRef.current);
      return;
    }
    try {
      recognition.stop();
    } catch {
      submitCaptureAsk(voiceSessionIdRef.current);
    }
  }

  function finishFollowUpListening() {
    window.clearTimeout(questionListenTimerRef.current);
    const recognition = questionRecognitionRef.current;
    if (questionVoiceActiveRef.current) questionVoiceActiveRef.current = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        questionRecognitionRef.current = null;
        setRecording(false);
        submitBrowserVoiceQuestion(voiceSessionIdRef.current);
      }
    } else if (!audioRecorderRef.current) {
      submitBrowserVoiceQuestion(voiceSessionIdRef.current);
    }
    const recorder = audioRecorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  }

  function submitBrowserVoiceQuestion(sessionId?: number) {
    if (sessionId && voiceSessionIdRef.current !== sessionId) return;
    if (questionVoiceSubmittedRef.current) return;
    questionVoiceSubmittedRef.current = true;
    questionVoiceActiveRef.current = false;
    questionRecognitionRef.current = null;
    setRecording(false);
    window.clearTimeout(questionListenTimerRef.current);
    const transcript = questionVoiceTranscriptRef.current.trim();
    if (!transcript) {
      setSpeechStatus("没有识别到声音，请靠近麦克风，按住 F9/F10 说完后再松开。");
      return;
    }
    setSpeechStatus("已收到语音，正在发送给 AI。");
    triggerTutor("manual", transcript, false, questionVoiceModeRef.current === "followup" ? "followup" : "voice");
  }

  async function startVoiceListening(mode: "new" | "followup") {
    if (recording) {
      finishFollowUpListening();
      return;
    }
    const followupTargetEvent = mode === "followup" ? getFollowupTargetEvent() : null;
    if (mode === "followup" && !followupTargetEvent) {
      setTab("tutor");
      setSpeechStatus("还没有可追问的学习事件。请先用 F8 截题求助或 F10 语音提问创建一个问题。");
      return;
    }
    if (mode === "followup" && followupTargetEvent && followupTargetEvent.id !== currentLearningEvent?.id) {
      setCurrentLearningEvent(followupTargetEvent);
    }
    setError("");
    setTab("tutor");
    setStudentQuestion("");
    setWakeTranscript("");

    const sessionId = Date.now();
    voiceSessionIdRef.current = sessionId;

    if (captureAskRecognitionRef.current) {
      try { captureAskRecognitionRef.current.abort(); } catch {}
      captureAskRecognitionRef.current = null;
    }
    captureAskActiveRef.current = false;
    captureAskSubmittedRef.current = true;

    setSpeechStatus(mode === "followup"
      ? "正在听孩子追问，松开后提交；本次不会重新拍题"
      : "正在听孩子语音提问，松开后提交；本次不会重新拍题"
    );
    if (aiConfig.useBackendAsr && aiConfig.asrBaseUrl.trim()) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const chunks: BlobPart[] = [];
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = async () => {
          if (voiceSessionIdRef.current !== sessionId) return;
          window.clearTimeout(questionListenTimerRef.current);
          stream.getTracks().forEach((track) => track.stop());
          audioRecorderRef.current = null;
          setRecording(false);
          const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (audio.size < 600) {
            setSpeechStatus("录音太短，请按住 F9/F10 或按钮说完整问题。");
            return;
          }
          try {
            setSpeechStatus("正在识别语音...");
            const result = await transcribeSpeech(normalizeAiConfig(aiConfig), audio);
            const transcriptText = result.text.trim();
            if (!transcriptText) {
              setSpeechStatus("后端语音识别没有返回文字，请靠近麦克风再试。");
              return;
            }
            if (voiceSessionIdRef.current !== sessionId) return;
            setStudentQuestion(transcriptText);
            setWakeTranscript(transcriptText);
            setSpeechStatus(`已识别：${transcriptText}`);
            triggerTutor("manual", transcriptText, false, mode === "followup" ? "followup" : "voice");
          } catch (err) {
            if (voiceSessionIdRef.current !== sessionId) return;
            setError(err instanceof Error ? err.message : "后端语音识别失败");
            setSpeechStatus("专用 ASR 识别失败。当前录音无法重新交给浏览器识别，请检查 ASR 地址和模型，或关闭后端 ASR 后重试。");
          }
        };
        audioRecorderRef.current = recorder;
        recorder.start(250);
        setRecording(true);
        setSpeechStatus(mode === "followup" ? "正在录音追问，松开后识别并发送。" : "正在录音提问，松开后识别并发送。");
        questionListenTimerRef.current = window.setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, 60000);
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : "无法访问麦克风");
        setSpeechStatus("无法访问麦克风，请检查浏览器权限或设备占用。");
        return;
      }
    }

    if (aiConfig.useBackendAsr && !aiConfig.asrBaseUrl.trim()) {
      setSpeechStatus("未配置专用 ASR 地址，已自动使用浏览器语音识别。");
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      questionVoiceActiveRef.current = true;
      questionVoiceSubmittedRef.current = false;
      questionVoiceTranscriptRef.current = "";
      questionVoiceModeRef.current = mode;
      recognition.lang = "zh-CN";
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        if (voiceSessionIdRef.current !== sessionId) return;
        let transcript = "";
        for (let i = 0; i <= event.resultIndex; i++) {
          transcript += event.results[i]?.[0]?.transcript || "";
        }
        if (transcript.trim()) {
          questionVoiceTranscriptRef.current = transcript.trim();
          setStudentQuestion(questionVoiceTranscriptRef.current);
          setWakeTranscript(questionVoiceTranscriptRef.current);
          setSpeechStatus(`已听到：${questionVoiceTranscriptRef.current}`);
        }
      };
      recognition.onerror = (event) => {
        if (voiceSessionIdRef.current !== sessionId) return;
        if (event.error === "network" || event.error === "aborted" || event.error === "not-allowed" || event.error === "service-not-allowed") {
          setError("语音识别服务不可用（国内网络可能无法访问语音服务器）。请直接按 F8 或点击「截题并求助」。");
        } else {
          setError(`语音识别失败：${event.error}`);
        }
      };
      recognition.onend = () => {
        if (voiceSessionIdRef.current !== sessionId) return;
        questionRecognitionRef.current = null;
        if (questionVoiceActiveRef.current) {
          setSpeechStatus("仍在按住，正在继续监听语音...");
          window.setTimeout(() => {
            if (voiceSessionIdRef.current !== sessionId) return;
            if (!questionVoiceActiveRef.current || questionRecognitionRef.current) return;
            questionRecognitionRef.current = recognition;
            try {
              recognition.start();
            } catch {
              questionRecognitionRef.current = null;
            }
          }, 180);
          return;
        }
        submitBrowserVoiceQuestion(sessionId);
      };
      questionRecognitionRef.current = recognition;
      setRecording(true);
      try {
        recognition.start();
      } catch (err) {
        questionVoiceActiveRef.current = false;
        questionRecognitionRef.current = null;
        setRecording(false);
        setSpeechStatus(err instanceof Error ? err.message : "语音监听启动失败");
        return;
      }
      questionListenTimerRef.current = window.setTimeout(() => {
        try {
          recognition.stop();
        } catch {
          setRecording(false);
        }
      }, 45000);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorder.onstop = () => {
        if (voiceSessionIdRef.current !== sessionId) return;
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const fallbackQuestion = "孩子通过语音提出了追问。请基于上一轮同一道题继续讲解，不要重新要求截图。";
        setStudentQuestion((current) => current || fallbackQuestion);
        triggerTutor("manual", fallbackQuestion, false, mode === "followup" ? "followup" : "voice");
      };
      audioRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      questionListenTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 45000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法访问麦克风");
    }
  }

  async function triggerTutor(
    trigger: "manual" | "care_offer" = "manual",
    overrideQuestion?: string,
    captureImage = true,
    interactionMode: "vision" | "voice" | "followup" = captureImage ? "vision" : "voice",
    bypassApproval = false,
    followupEventId = ""
  ) {
    if (aiBusy) return;
    const followupTargetEvent = interactionMode === "followup" ? getFollowupTargetEvent(followupEventId) : null;
    if (interactionMode === "followup" && !followupTargetEvent?.id) {
      setTab("tutor");
      setSpeechStatus("还没有可追问的学习事件。请先用 F8 截题求助或 F10 语音提问创建一个问题。");
      return;
    }
    if (followupTargetEvent && followupTargetEvent.id !== currentLearningEvent?.id) {
      setCurrentLearningEvent(followupTargetEvent);
    }
    const aiTeacherMode = parentState?.settings.aiTeacherMode || "enabled";
    if (aiTeacherMode === "disabled") {
      setShowAiDisabledModal(true);
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = 440;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.3);
      } catch {}
      return;
    }
    if (aiTeacherMode === "ask_parent" && !bypassApproval) {
      setTab("tutor");
      setCareOffer(false);

      const rawQuestion = overrideQuestion || (interactionMode !== "vision" ? studentQuestion : "") || "孩子请求 AI 教师帮助当前题目，请根据孩子手指所在的题目区域引导。";
      const requestId = "q_" + Date.now();

      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const playTone = (freq: number, start: number, duration: number) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.frequency.setValueAtTime(freq, audioCtx.currentTime + start);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0, audioCtx.currentTime + start);
          gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + start + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + start + duration);
          osc.start(audioCtx.currentTime + start);
          osc.stop(audioCtx.currentTime + start + duration);
        };
        playTone(350, 0, 0.15);
        playTone(350, 0.18, 0.15);
      } catch {}

      setPendingQuestionRequest({
        id: requestId,
        text: rawQuestion,
        captureImage,
        interactionMode,
        targetEventId: followupTargetEvent?.id
      });
      setTutorAnswer("> 正在向家长申请使用 AI 教师，请在家长手机端点击确认...");
      setSpeechStatus("正在向家长申请使用 AI 教师。");
      return;
    }
    setError("");
    setAiBusy(true);
    setCareOffer(false);
    try {
      const requestConfig = normalizeAiConfig(aiConfig);
      if (requestConfig.baseUrl !== aiConfig.baseUrl) setAiConfig(requestConfig);
      const imageDataUrl = requestConfig.allowImageUpload && captureImage
        ? writingDetectorRef.current?.capturePaperImage(requestConfig.captureMode) ?? null
        : null;
      const rawQuestion = overrideQuestion || (interactionMode !== "vision" ? studentQuestion : "") || "孩子请求 AI 教师帮助当前题目，请根据孩子手指所在的题目区域引导。";
      const questionAudioText = buildTutorQuestion(rawQuestion, captureImage, tutorAnswer);
      const tutorRequest = {
        questionAudioText,
        imageDataUrl,
        config: requestConfig,
        profile,
        trigger,
        persistMistake: Boolean(imageDataUrl) && interactionMode !== "followup",
        interactionMode,
        eventId: interactionMode === "followup" ? followupTargetEvent?.id || "" : ""
      };
      let quickSpoken = false;
      let streamedText = "";
      let isSpeakingQuick = false;
      const response = requestConfig.useStreaming
        ? await askTutorStream(tutorRequest, {
            onStatus: (message) => setTutorAnswer(`> ${message}\n\nAI 正在继续解析题目...`),
            onQuick: (text) => {
              quickSpoken = true;
              isSpeakingQuick = true;
              setTutorAnswer(`> ${text}\n\nAI 正在继续解析题目...`);
            },
            onToken: (token) => {
              streamedText += token;
              const partial = extractAnswerMarkdown(streamedText);
              if (partial) {
                setTutorAnswer(partial);
              } else {
                setTutorAnswer("> AI 正在解析题目，稍等...");
              }
            }
          }).catch((streamError) => {
            setTutorAnswer("> 流式反馈暂时不可用，正在改用普通 AI 请求...");
            if (!quickSpoken) speakAnswer("我正在看这道题，请先找出题目中的已知条件。", false);
            setTutorAnswer("> AI 请求失败。本地后端仍在运行，请检查第三方模型服务、API Key、模型名称，或在配置里关闭流式后重试。");
            if (streamError instanceof Error) setError(streamError.message);
            throw streamError;
          })
        : await askTutor(tutorRequest);
      const cleanAnswer = extractAnswerMarkdown(response.answerMarkdown) || response.answerMarkdown;
      const responseEventFinalAnswer = response.event?.finalAnswerMarkdown || "";
      const cleanFinalAnswer = extractAnswerMarkdown(responseEventFinalAnswer || response.finalAnswerMarkdown) || responseEventFinalAnswer || response.finalAnswerMarkdown || "";
      setTutorAnswer(cleanAnswer);
      setTutorFinalAnswer(cleanFinalAnswer);
      const speakFinal = () => speakAnswer(cleanAnswer, conversationMode);
      if (isSpeakingQuick) {
        window.setTimeout(speakFinal, 1200);
      } else {
        speakFinal();
      }
      if (response.event) {
        setCurrentLearningEvent(response.event);
        setLearningEvents((current) => [response.event!, ...current.filter((item) => item.id !== response.event!.id)]);
      }
      setCosts((prev) => ({
        todayCalls: prev.todayCalls + 1,
        todayEstimatedUsd: prev.todayEstimatedUsd + response.estimatedCostUsd,
        weekEstimatedUsd: prev.weekEstimatedUsd + response.estimatedCostUsd,
        activeAiCalls: prev.activeAiCalls + 1
      }));
      if (response.mistake.id) {
        saveMistake(response.mistake);
        setMistakes((prev) => [response.mistake, ...prev]);
        await refreshCostsAndMistakes();
      } else {
        await getCostSummary(aiConfig.baseUrl).then(setCosts).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 教师请求失败");
    } finally {
      setAiBusy(false);
    }
  }

  async function setSelectedKnowledgeStatus(pageId: string, status: "weak" | "learning" | "mastered" | "ignored") {
    setWikiBusy("status");
    try {
      const page = await updateKnowledgeStatus(aiConfig.baseUrl, pageId, status);
      setSelectedWikiPage(page);
      await refreshWikiData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "知识点状态更新失败");
    } finally {
      setWikiBusy("");
    }
  }

  async function refreshWikiData() {
    const [pages, graph] = await Promise.all([fetchWikiPages(aiConfig.baseUrl), fetchWikiGraph(aiConfig.baseUrl)]);
    setWikiPages(pages);
    setWikiGraph(graph);
    refreshLegacyWiki();
  }

  async function revealCurrentAnswer() {
    if (!currentLearningEvent) return;
    const previous = currentLearningEvent;
    setCurrentLearningEvent({ ...previous, answerRevealed: true });
    try {
      const event = await revealLearningEventAnswer(aiConfig.baseUrl, currentLearningEvent.id);
      const merged = { ...previous, ...event, answerRevealed: true, finalAnswerMarkdown: event.finalAnswerMarkdown || previous.finalAnswerMarkdown };
      setCurrentLearningEvent(merged);
      setTutorFinalAnswer(merged.finalAnswerMarkdown || tutorFinalAnswer);
      setLearningEvents((current) => current.map((item) => item.id === merged.id ? merged : item));
    } catch (err) {
      setCurrentLearningEvent(previous);
      setError(err instanceof Error ? err.message : "最终答案解锁失败");
    }
  }

  function selectLearningEvent(event: LearningEvent) {
    setCurrentLearningEvent(event);
    setTutorAnswer(event.reasoningMarkdown);
    setTutorFinalAnswer(event.finalAnswerMarkdown);
    setStudentQuestion(event.originalQuestion);
    setTab("tutor");
  }

  async function promoteCurrentEvent() {
    if (!currentLearningEvent) return;
    try {
      const page = await promoteLearningEvent(aiConfig.baseUrl, currentLearningEvent.id);
      setSelectedWikiPage(page);
      await refreshWikiData();
      setTab("wiki");
    } catch (err) {
      setError(err instanceof Error ? err.message : "沉淀知识点失败");
    }
  }

  async function recognizeCalendarMemo(selectedDate: string) {
    const requestConfig = normalizeAiConfig(aiConfig);
    if (requestConfig.baseUrl !== aiConfig.baseUrl) setAiConfig(requestConfig);
    const imageDataUrl = requestConfig.allowImageUpload
      ? writingDetectorRef.current?.capturePaperImage("paper") ?? writingDetectorRef.current?.capturePaperImage("full") ?? null
      : null;
    if (!imageDataUrl) {
      throw new Error("没有可用的俯拍截图。请先在监控页启动俯拍摄像头，并把手写备忘录放在卷面框内。");
    }
    const result = await recognizeMemoTodos({ imageDataUrl, selectedDate, config: requestConfig, profile });
    if (!result.todos.length) {
      throw new Error(result.note || "没有从手写备忘录中识别到可写入日历的作业条目。");
    }
    return result.todos;
  }

  async function deleteMistake(id: string) {
    const next = mistakes.filter((entry) => entry.id !== id);
    setMistakes(next);
    deleteMistakeLocal(id);
    try {
      await deleteMistakeRemote(aiConfig.baseUrl, id);
      await refreshCostsAndMistakes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "错题删除失败");
    }
  }

  async function updateMistakeSubject(entry: MistakeEntry, subject: string) {
    const updated = { ...entry, subject };
    setMistakes((prev) => prev.map((item) => (item.id === entry.id ? updated : item)));
    updateMistake(updated);
    try {
      await updateMistakeRemote(aiConfig.baseUrl, updated);
      await refreshCostsAndMistakes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "错题学科更新失败");
    }
  }

  async function speakAnswer(markdown: string | any = tutorAnswer, listenAfter = false) {
    let rawText = typeof markdown === "string" ? markdown : tutorAnswer;
    rawText = rawText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    if (!rawText || !rawText.trim()) { setSpeechStatus("还没有可朗读的解答"); return; }
    const doubleDollarCount = (rawText.match(/\$\$/g) || []).length;
    if (doubleDollarCount % 2 !== 0) rawText = rawText + "\n$$";
    const singleDollarCount = (rawText.replace(/\$\$/g, "").match(/\$/g) || []).length;
    if (singleDollarCount % 2 !== 0) rawText = rawText + "$";
    let text = rawText
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => cleanMathForSpeech(math))
      .replace(/\$([^$]+?)\$/g, (_, math) => cleanMathForSpeech(math))
      .replace(/<[^>]*>/g, " ")
      .replace(/[#>*_\-\[\]()`]/g, " ")
      .replace(/\n+/g, "，")
      .replace(/\s+/g, " ")
      .trim();
    const shortText = summarizeSpeechText(text);
    if (aiConfig.ttsMode === "edge-tts") {
      try {
        setSpeechStatus("正在生成 Edge 神经语音...");
        const blob = await synthesizeSpeechEdge(aiConfig, shortText);
        playAudioBlob(blob, listenAfter);
        return;
      } catch (err) {
        setSpeechStatus(`Edge TTS 失败，已回退浏览器朗读：${err instanceof Error ? err.message : ""}`);
      }
    } else if (aiConfig.ttsMode === "cloud") {
      try {
        setSpeechStatus("正在生成语音...");
        const blob = await synthesizeSpeech(normalizeAiConfig(aiConfig), shortText);
        playAudioBlob(blob, listenAfter);
        return;
      } catch (err) {
        setSpeechStatus("云端语音合成失败，已回退浏览器朗读。");
      }
    }
    if (!("speechSynthesis" in window)) { setSpeechStatus("当前浏览器不支持语音朗读"); return; }
    window.speechSynthesis.cancel();
    speakTextChunks(shortText, listenAfter);
  }

  function playAudioBlob(blob: Blob, listenAfter: boolean) {
    const url = URL.createObjectURL(blob);
    if (ttsAudioRef.current) { ttsAudioRef.current.pause(); URL.revokeObjectURL(ttsAudioRef.current.src); }
    const audio = new Audio(url);
    ttsAudioRef.current = audio;
    audio.onended = () => {
      setSpeechStatus(listenAfter && conversationMode ? "语音结束，按住 F9 继续追问，按住 F10 提新问题" : "语音结束");
      URL.revokeObjectURL(url);
      ttsAudioRef.current = null;
    };
    audio.onerror = () => { URL.revokeObjectURL(url); ttsAudioRef.current = null; setSpeechStatus("语音播放失败"); };
    audio.play().catch(() => setSpeechStatus("语音播放被拦截，请先与页面交互再试。"));
    setSpeechStatus("正在播放语音");
  }

  function speakTextChunks(text: string, listenAfter = false) {
    const voices = speechVoices.length ? speechVoices : window.speechSynthesis.getVoices();
    const selectedVoice = voices.find((voice) => voice.name === profile.speechVoiceName);
    const zhVoices = voices.filter((voice) => voice.lang.toLowerCase().includes("zh"));
    const bestVoice = selectedVoice
      || zhVoices.find((voice) => /natural|online|xiaoxiao|xiaoyi|yunxi|google/i.test(voice.name))
      || zhVoices.find((voice) => voice.name.includes("Xiaoxiao"))
      || zhVoices.find((voice) => voice.name.includes("Yunxi"))
      || zhVoices.find((voice) => voice.name.includes("Google"))
      || zhVoices[0];
    const chunks = splitSpeechText(text, 160);
    if (!chunks.length) return;
    if (!bestVoice) { setSpeechStatus("未找到中文语音。Edge 请安装 Windows 中文语音包，或改用 Chrome/Google 中文语音。"); return; }
    setSpeechStatus(`正在朗读：${bestVoice.name}`);
    const runId = ++speechRunIdRef.current;
    if (speechKeepAliveRef.current) window.clearInterval(speechKeepAliveRef.current);
    let currentIndex = 0;
    speechKeepAliveRef.current = window.setInterval(() => {
      if (runId !== speechRunIdRef.current) {
        if (speechKeepAliveRef.current) window.clearInterval(speechKeepAliveRef.current);
        speechKeepAliveRef.current = null;
        return;
      }
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.cancel();
        window.setTimeout(() => {
          if (runId === speechRunIdRef.current) {
            const u = new SpeechSynthesisUtterance(chunks[currentIndex] || "");
            u.lang = "zh-CN"; u.rate = profile.speechRate || 1.12; u.pitch = profile.speechPitch || 1.04;
            if (bestVoice) u.voice = bestVoice;
            window.speechSynthesis.speak(u);
          }
        }, 80);
      }
    }, 200);
    let index = 0;
    let retriedWithoutVoice = false;
    const speakNext = () => {
      if (runId !== speechRunIdRef.current) return;
      currentIndex = index;
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = "zh-CN";
      utterance.rate = profile.speechRate || 1.12;
      utterance.pitch = profile.speechPitch || 1.04;
      if (bestVoice && !retriedWithoutVoice) utterance.voice = bestVoice;
      utterance.onerror = () => {
        if (bestVoice && !retriedWithoutVoice) {
          retriedWithoutVoice = true;
          window.speechSynthesis.cancel();
          window.setTimeout(speakNext, 80);
          return;
        }
        speechRunIdRef.current += 1;
        if (speechKeepAliveRef.current) window.clearInterval(speechKeepAliveRef.current);
        speechKeepAliveRef.current = null;
        setSpeechStatus("语音朗读失败。请换一个声音，或安装系统中文语音包。");
      };
      utterance.onend = () => {
        if (runId !== speechRunIdRef.current) return;
        index += 1;
        if (index < chunks.length) { speakNext(); return; }
        if (speechKeepAliveRef.current) window.clearInterval(speechKeepAliveRef.current);
        speechKeepAliveRef.current = null;
        setSpeechStatus(listenAfter && conversationMode ? "朗读结束，按住 F9 继续追问，按住 F10 提新问题" : "朗读结束");
      };
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  }

  function summarizeSpeechText(text: string) {
    const sentences = text
      .split(/[。！？；]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/题干|知识点|掌握度|错因|```|^\s*[-*#]/.test(part));
    const picked = sentences.slice(0, 5).join("。");
    const base = picked || text.slice(0, 500);
    const clipped = base.length > 600 ? `${base.slice(0, 600)}。` : `${base}。`;
    return text.length > clipped.length + 80
      ? `${clipped}更多细节已经显示在屏幕上，你可以继续问我卡住的那一步。`
      : clipped;
  }

  function splitSpeechText(text: string, maxLen: number) {
    const parts = text.split(/[。！？；]/).map((part) => part.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = "";
    for (const part of parts) {
      if ((current + part).length > maxLen && current) { chunks.push(current); current = ""; }
      current += `${part}。`;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function cleanMathForSpeech(math: string): string {
    let clean = math;

    // 1. Replace fractions \frac{A}{B} -> B分之A
    for (let i = 0; i < 3; i++) {
      const next = clean.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, num, den) => {
        return `${den}分之${num}`;
      });
      if (next === clean) break;
      clean = next;
    }

    // 2. Replace square roots \sqrt{A} -> 根号下A
    for (let i = 0; i < 3; i++) {
      const next = clean.replace(/\\sqrt\s*\{([^{}]+)\}/g, (_, content) => {
        return `根号下${content}`;
      });
      if (next === clean) break;
      clean = next;
    }

    // 3. Replace exponents ^2 -> 的平方, ^3 -> 的立方, ^{n} -> 的n次方
    clean = clean
      .replace(/\^\{\s*2\s*\}/g, "的平方")
      .replace(/\^2/g, "的平方")
      .replace(/\^\{\s*3\s*\}/g, "的立方")
      .replace(/\^3/g, "的立方")
      .replace(/\^\{\s*([^{}]+)\s*\}/g, (_, exp) => `的${exp}次方`)
      .replace(/\^([0-9a-zA-Z])/g, (_, exp) => `的${exp}次方`);

    // 4. Common operators and LaTeX commands
    clean = clean
      .replace(/\\times/g, " 乘 ")
      .replace(/\\cdot/g, " 乘 ")
      .replace(/\*/g, " 乘 ")
      .replace(/\\div/g, " 除以 ")
      .replace(/\//g, " 除以 ")
      .replace(/\\pm/g, " 正负 ")
      .replace(/\\leq/g, " 小于等于 ")
      .replace(/\\geq/g, " 大于等于 ")
      .replace(/\\neq/g, " 不等于 ")
      .replace(/\\approx/g, " 约等于 ")
      .replace(/\\dots/g, " 点点点 ")
      .replace(/\\cdots/g, " 点点点 ")
      .replace(/\\pi/g, " 派 ")
      .replace(/\\alpha/g, " 阿尔法 ")
      .replace(/\\beta/g, " 贝塔 ")
      .replace(/\\theta/g, " 西塔 ")
      .replace(/\\angle/g, " 角 ")
      .replace(/\\triangle/g, " 三角形 ")
      .replace(/\\degree/g, " 度 ")
      .replace(/\\infty/g, " 无穷 ")
      .replace(/\\left\(/g, " 括号 ")
      .replace(/\\right\)/g, " 括号 ")
      .replace(/\\left\[/g, " 括号 ")
      .replace(/\\right\]/g, " 括号 ")
      .replace(/\\left\\\{/g, " 括号 ")
      .replace(/\\right\\\}/g, " 括号 ")
      .replace(/\\left/g, "")
      .replace(/\\right/g, "")
      .replace(/\\text\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\mathrm\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\mathbf\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\vec/g, " 向量 ")
      .replace(/\\overline\s*\{([^{}]+)\}/g, "线段$1");

    // 5. Basic operators
    clean = clean
      .replace(/\+/g, " 加 ")
      .replace(/-/g, " 减 ")
      .replace(/=/g, " 等于 ")
      .replace(/</g, " 小于 ")
      .replace(/>/g, " 大于 ");

    // 6. Alphabet reading
    clean = clean
      .replace(/\bx\b/gi, " 艾克斯 ")
      .replace(/\by\b/gi, " 歪 ")
      .replace(/\bz\b/gi, " 贼东 ")
      .replace(/\ba\b/gi, " 诶 ")
      .replace(/\bb\b/gi, " 必 ")
      .replace(/\bc\b/gi, " 细 ")
      .replace(/\bd\b/gi, " 弟 ")
      .replace(/\be\b/gi, " 易 ")
      .replace(/\bf\b/gi, " 艾弗 ");

    // 7. Strip remaining braces and backslashes
    clean = clean
      .replace(/[{}]/g, " ")
      .replace(/\\/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return clean;
  }

  function exportCsv() {
    const rows = ["time,state,reason,motionScore", ...samples.map((s) => `${new Date(s.ts).toISOString()},${s.state},"${s.reason}",${s.motionScore.toFixed(2)}`)];
    const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "focuslens-v2-session.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function dismissParentReminder() {
    const current = parentReminder;
    setParentReminder(null);
    if (!current) return;
    try {
      const state = await markParentReminderDelivered(aiConfig.baseUrl, current.id);
      setParentState(state);
    } catch {
      // The visible reminder has already been acknowledged locally.
    }
  }

  async function handleCancelPendingRequest() {
    if (!pendingQuestionRequest) return;
    const req = pendingQuestionRequest;
    setPendingQuestionRequest(null);
    try {
      const lastLearningAt = samples.length ? new Date(samples[samples.length - 1].ts).toISOString() : "";
      const state = await updateParentStatus(aiConfig.baseUrl, {
        learningState: fused.state,
        reason: fused.reason,
        writingActive: writingSignal.active,
        absent: frontSignal.absent,
        aiBusy,
        activeTab: tab,
        lastLearningAt,
        samples: samples.slice(-300),
        pendingQuestionId: req.id,
        pendingQuestionText: req.text,
        aiApprovalStatus: "none"
      });
      setParentState(state);
    } catch {
      // Ignored
    }
  }

  const handleTabChange = (nextTab: AppTab) => {
    if (nextTab === "tutor" && (parentState?.settings.aiTeacherMode || "enabled") === "disabled") {
      setShowAiDisabledModal(true);
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = 440;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.3);
      } catch {}
      return;
    }
    setTab(nextTab);
  };

  if (isParentConsole) {
    return <ParentConsolePage baseUrl={aiConfig.baseUrl} />;
  }

  return (
    <main className={`app-shell ${navCollapsed ? "nav-collapsed" : ""}`}>
      {isBlackout && (
        <div className="blackout">
          <h2>沉浸护眼陪伴模式</h2>
          <p>摄像头和 AI 状态机仍在后台运行。按 Esc 返回。</p>
          <div className={`blackout-state ${fused.state.toLowerCase()}`}>{stateLabel(fused.state)}</div>
        </div>
      )}

      <header className={showSearch ? "topbar" : "topbar empty"}>
        {showSearch ? (
          <label className="search-box">
            <Search size={17} />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索错题、知识点或学习记录" />
          </label>
        ) : <div />}
        <div className="top-actions" />
      </header>

      <nav className="tabs" aria-label="FocusLens 功能页">
        <button
          type="button"
          className="nav-collapse-toggle"
          onClick={() => setNavCollapsed((value) => !value)}
          aria-label={navCollapsed ? "展开侧边栏" : "收起侧边栏"}
          title={navCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {navCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          <span>{navCollapsed ? "展开" : "收起"}</span>
        </button>
        <TabButton tab="dashboard" active={tab} onClick={handleTabChange} icon={<LayoutDashboard size={18} />} label="Dashboard" />
        <TabButton tab="calendar" active={tab} onClick={handleTabChange} icon={<Calendar size={18} />} label="学习日历" />
        <TabButton tab="monitor" active={tab} onClick={handleTabChange} icon={<Eye size={18} />} label="监控" />
        <TabButton tab="tutor" active={tab} onClick={handleTabChange} icon={<HelpCircle size={18} />} label="AI 教师" />
        <TabButton tab="mistakes" active={tab} onClick={handleTabChange} icon={<BookOpen size={18} />} label="错题知识点" />
        <TabButton tab="wiki" active={tab} onClick={handleTabChange} icon={<Brain size={18} />} label="Wiki" />
        <TabButton tab="materials" active={tab} onClick={handleTabChange} icon={<FileCheck2 size={18} />} label="学习材料" />
        <TabButton tab="settings" active={tab} onClick={handleTabChange} icon={<Settings size={18} />} label="配置" />
      </nav>

      {error && <div className="error"><WifiOff size={18} />{error}</div>}
      {careOffer && (
        <div className="care-banner">
          <Brain size={20} />
          <span>这道题停了比较久，需要 AI 教师轻轻提示一下吗？</span>
          <button onClick={() => triggerTutor("care_offer")} disabled={aiBusy}>需要帮助</button>
          <button className="ghost" onClick={() => setCareOffer(false)}>继续思考</button>
        </div>
      )}

      <section className={tab === "dashboard" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "dashboard"}>
        <DashboardPage
          fusedState={fused.state}
          fusedReason={fused.reason}
          writingSignal={writingSignal}
          summary={summary}
          costs={costs}
          mistakes={mistakes}
          wiki={wiki}
          samples={allSamples}
          searchQuery={searchQuery}
          isVisionOn={isVisionOn}
          isSessionActive={isSessionActive}
          aiBusy={aiBusy}
          onStartVision={startVision}
          onStartSession={startSession}
          onTutor={() => {
            setTab("tutor");
            triggerTutor("manual");
          }}
          onOpenMistakes={() => setTab("mistakes")}
          onOpenCalendar={() => setTab("calendar")}
        />
      </section>

      <section className={tab === "calendar" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "calendar"}>
        <CalendarPage
          samples={allSamples}
          mistakes={mistakes}
          summary={summary}
          onOpenMonitor={() => setTab("monitor")}
          onOpenMistakes={() => setTab("mistakes")}
          onRecognizeMemo={recognizeCalendarMemo}
        />
      </section>

      <section className={tab === "monitor" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "monitor"}>
        <section className="control-strip">
          <DeviceSelect label="正面摄像头" value={frontDeviceId} devices={devices} onChange={setFrontDeviceId} />
          <DeviceSelect label="俯拍摄像头" value={paperDeviceId} devices={devices} onChange={setPaperDeviceId} />
          <button onClick={isVisionOn ? stopVision : startVision}><Camera size={18} />{isVisionOn ? "停止摄像头" : "启动双摄像头"}</button>
          <button onClick={isSessionActive ? stopSession : startSession}><Play size={18} />{isSessionActive ? "结束学习" : "开始学习"}</button>
          <button onClick={() => setPaused((v) => !v)} disabled={!isSessionActive}>{isPaused ? <Play size={18} /> : <Pause size={18} />}{isPaused ? "继续" : "暂停"}</button>
          <button className="ghost" onClick={enterBlackout}><Moon size={18} />黑屏护眼</button>
        </section>
        <MonitorPage
          frontVideoRef={frontVideoRef}
          frontCanvasRef={frontCanvasRef}
          paperVideoRef={paperVideoRef}
          paperCanvasRef={paperCanvasRef}
          frontSignal={frontSignal}
          writingSignal={writingSignal}
          fusedState={fused.state}
          fusedReason={fused.reason}
          samples={samples}
          summary={summary}
          reminderEnabled={reminderEnabled}
          setReminderEnabled={setReminderEnabled}
          reminderRecording={reminderRecording}
          customReminderUrl={customReminderUrl}
          playReminder={playReminder}
          toggleReminderRecording={toggleReminderRecording}
          clearCustomReminder={clearCustomReminder}
          aiConfig={aiConfig}
          setAiConfig={setAiConfig}
          bgMusicUrl={bgMusicUrl}
          setBgMusicUrl={setBgMusicUrl}
          bgMusicPlaying={bgMusicPlaying}
          toggleBgMusic={toggleBgMusic}
        />
      </section>

      <section className={tab === "tutor" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "tutor"}>
        <TutorPage
          paperCanvasRef={paperCanvasRef}
          studentQuestion={studentQuestion}
          recording={recording}
          wakeListening={wakeListening}
          wakeStatus={wakeStatus}
          wakeTranscript={wakeTranscript}
          teacherName={profile.teacherName}
          recordQuestion={recordQuestion}
          startWakeListening={startWakeListening}
          triggerTutor={triggerTutor}
          startCaptureAskListening={startCaptureAskListening}
          finishCaptureAskListening={finishCaptureAskListening}
          followUpQuestion={() => startVoiceListening("followup")}
          finishFollowUpListening={finishFollowUpListening}
          aiBusy={aiBusy}
          tutorAnswer={tutorAnswer}
          tutorFinalAnswer={tutorFinalAnswer}
          currentEvent={currentLearningEvent}
          learningEvents={learningEvents}
          revealAnswer={revealCurrentAnswer}
          promoteEvent={promoteCurrentEvent}
          selectEvent={selectLearningEvent}
          speakAnswer={speakAnswer}
          conversationMode={conversationMode}
          setConversationMode={setConversationMode}
          speechStatus={speechStatus}
        />
      </section>

      <section className={tab === "settings" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "settings"}>
        <SettingsPage
          config={aiConfig}
          onConfig={setAiConfig}
          profile={profile}
          onProfile={setProfile}
          thresholds={thresholds}
          onThresholds={setThresholds}
          costs={costs}
          speechVoices={speechVoices}
          refreshCosts={refreshCostsAndMistakes}
          exportCsv={exportCsv}
          canExportCsv={samples.length > 0}
          parentConsoleUrl={buildParentConsoleUrl()}
        />
      </section>

      <section className={tab === "wiki" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "wiki"}>
        <WikiWorkspace baseUrl={aiConfig.baseUrl} aiConfig={aiConfig} onError={setError} onOpenEvidenceInbox={() => setTab("mistakes")} />
      </section>

      <section className={tab === "materials" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "materials"}>
        <MaterialsPage
          baseUrl={aiConfig.baseUrl}
          aiConfig={aiConfig}
          pages={materialPages}
          terms={materialTerms}
          termId={materialTermId}
          onTermChange={setMaterialTermId}
          onError={setError}
        />
      </section>

      <section className={tab === "mistakes" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "mistakes"}>
        <MistakesPage
          mistakes={mistakes}
          wiki={wiki}
          wikiInbox={wikiInbox}
          searchQuery={searchQuery}
          onDelete={deleteMistake}
          onSubjectChange={updateMistakeSubject}
          onConfirmInbox={confirmWikiInboxEvidence}
          onDeleteInbox={deleteWikiInboxEvidence}
          onRerunInbox={rerunWikiInboxEvidence}
          onOpenWiki={() => setTab("wiki")}
        />
      </section>

      {parentReminder && (
        <div className="modal-backdrop">
          <div className="todo-modal" style={{ textAlign: "center", padding: "30px", maxWidth: "450px" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px", color: "#2563eb" }}>
              <Brain size={48} />
            </div>
            <h2 style={{ margin: "0 0 10px", fontSize: "24px", color: "#13233d" }}>家长提醒</h2>
            <p style={{ margin: "0 0 24px", fontSize: "16px", color: "#51627b", lineHeight: "1.6" }}>
              {parentReminder.message}
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
              <button
                onClick={dismissParentReminder}
                style={{
                  background: "#2563eb",
                  color: "white",
                  border: 0,
                  borderRadius: "12px",
                  padding: "12px 24px",
                  fontWeight: "bold",
                  fontSize: "16px",
                  cursor: "pointer",
                  flex: 1
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {showAiDisabledModal && (
        <div className="modal-backdrop">
          <div className="todo-modal" style={{ textAlign: "center", padding: "30px", maxWidth: "450px" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px", color: "#f59e0b" }}>
              <Brain size={48} />
            </div>
            <h2 style={{ margin: "0 0 10px", fontSize: "24px", color: "#13233d" }}>AI 教师已关闭</h2>
            <p style={{ margin: "0 0 24px", fontSize: "16px", color: "#51627b", lineHeight: "1.6" }}>
              家长端已暂时关闭 AI 教师功能。请先继续独立思考，或者请家长在手机端重新开启。
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
              <button
                onClick={() => setShowAiDisabledModal(false)}
                style={{
                  background: "#f59e0b",
                  color: "white",
                  border: 0,
                  borderRadius: "12px",
                  padding: "12px 24px",
                  fontWeight: "bold",
                  fontSize: "16px",
                  cursor: "pointer",
                  flex: 1
                }}
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingQuestionRequest && (
        <div className="modal-backdrop">
          <div className="todo-modal" style={{ textAlign: "center", padding: "30px", maxWidth: "450px" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px", color: "#1e40af" }}>
              <Brain size={48} />
            </div>
            <h2 style={{ margin: "0 0 10px", fontSize: "24px", color: "#13233d" }}>等待使用授权</h2>
            <p style={{ margin: "0 0 16px", fontSize: "15px", color: "#51627b", lineHeight: "1.6" }}>
              已向家长手机端发送 AI 教师使用申请，请等待确认。
            </p>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px", marginBottom: "20px", fontSize: "14px", color: "#64748b", textAlign: "left", wordBreak: "break-all", maxHeight: "100px", overflowY: "auto" }}>
              <strong>申请提问：</strong>
              {pendingQuestionRequest.text}
            </div>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
              <button
                onClick={handleCancelPendingRequest}
                style={{
                  background: "#64748b",
                  color: "white",
                  border: 0,
                  borderRadius: "12px",
                  padding: "12px 24px",
                  fontWeight: "bold",
                  fontSize: "16px",
                  cursor: "pointer",
                  flex: 1
                }}
              >
                取消申请
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function DashboardPage({
  fusedState,
  fusedReason,
  writingSignal,
  summary,
  costs,
  mistakes,
  wiki,
  samples,
  searchQuery,
  isVisionOn,
  isSessionActive,
  aiBusy,
  onStartVision,
  onStartSession,
  onTutor,
  onOpenMistakes,
  onOpenCalendar
}: {
  fusedState: LearningState;
  fusedReason: string;
  writingSignal: WritingSignal;
  summary: ReturnType<typeof summarizeSession>;
  costs: CostSummary;
  mistakes: MistakeEntry[];
  wiki: KnowledgeWiki[];
  samples: SessionSample[];
  searchQuery: string;
  isVisionOn: boolean;
  isSessionActive: boolean;
  aiBusy: boolean;
  onStartVision: () => void;
  onStartSession: () => void;
  onTutor: () => void;
  onOpenMistakes: () => void;
  onOpenCalendar: () => void;
}) {
  const today = new Date();
  const query = searchQuery.trim().toLowerCase();
  const todayKey = dateKey(today);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const [heatmapMetric, setHeatmapMetric] = useState<"focus" | "writing" | "questions">("focus");
  const [showQuickCards, setShowQuickCards] = useState(true);
  const [quickDensity, setQuickDensity] = useState<"compact" | "comfortable">("comfortable");
  const [dashboardLayout, setDashboardLayout] = useState<DashboardCardConfig[]>(loadDashboardLayout);
  const [draggingCard, setDraggingCard] = useState<DashboardCardId | null>(null);
  const [todoOpen, setTodoOpen] = useState(false);
  const [layoutSettingsOpen, setLayoutSettingsOpen] = useState(false);
  const [customTodos, setCustomTodos] = useState<Record<string, { id: string; text: string; done: boolean }[]>>(loadCalendarTodos);
  const [newTodoText, setNewTodoText] = useState("");
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - today.getDay() + index);
    return date;
  });
  const filteredWiki = query
    ? wiki.filter((item) => `${item.subject} ${item.knowledgePoint} ${item.markdown}`.toLowerCase().includes(query))
    : wiki;
  const filteredMistakes = query
    ? mistakes.filter((entry) => `${entry.subject} ${entry.knowledgePoint} ${entry.mistakeReason} ${entry.questionText ?? ""} ${entry.studentQuestion}`.toLowerCase().includes(query))
    : mistakes;
  const todaySamples = samples.filter((sample) => dateKey(new Date(sample.ts)) === todayKey);
  const todayMistakes = filteredMistakes.filter((entry) => dateKey(new Date(entry.createdAt)) === todayKey);
  const weakPoints = filteredWiki.slice(0, 4);
  const latestMistakes = todayMistakes.slice(0, 3);
  const activePercent = Math.min(100, Math.max(0, summary.score));
  const minutes = Math.floor(summary.durationSec / 60);
  const greeting = getTimeGreeting(today);
  const selectedTodo = customTodos[selectedDateKey] ?? [];
  const selectedDate = parseDateKey(selectedDateKey);
  const visibleCards = dashboardLayout.filter((card) => card.visible);

  useEffect(() => {
    saveDashboardLayout(dashboardLayout);
  }, [dashboardLayout]);

  useEffect(() => {
    saveCalendarTodos(customTodos);
  }, [customTodos]);

  const cardConfig = (id: DashboardCardId) => dashboardLayout.find((card) => card.id === id) ?? defaultDashboardLayout.find((card) => card.id === id)!;
  const isVisible = (id: DashboardCardId) => cardConfig(id).visible;
  const cardIndex = (id: DashboardCardId) => visibleCards.findIndex((card) => card.id === id);
  const cardProps = (id: DashboardCardId, extraClass = "") => ({
    draggable: true,
    onDragStart: () => setDraggingCard(id),
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDrop: () => {
      if (draggingCard && draggingCard !== id) {
        setDashboardLayout((layout) => reorderDashboardCards(layout, draggingCard, id));
      }
      setDraggingCard(null);
    },
    onDragEnd: () => setDraggingCard(null),
    style: { order: cardIndex(id) },
    className: `dashboard-card ${extraClass} size-${cardConfig(id).size}`
  });
  const updateCardSize = (id: DashboardCardId, size: DashboardCardSize) => {
    setDashboardLayout((layout) => layout.map((card) => card.id === id ? { ...card, size } : card));
  };
  const toggleCard = (id: DashboardCardId) => {
    setDashboardLayout((layout) => layout.map((card) => card.id === id ? { ...card, visible: !card.visible } : card));
  };
  const resetLayout = () => setDashboardLayout(defaultDashboardLayout);
  const openTodoForDate = (key: string) => {
    setSelectedDateKey(key);
    setCustomTodos((todos) => todos[key] ? todos : { ...todos, [key]: [] });
  };
  const toggleTodo = (id: string) => {
    setCustomTodos((todos) => ({
      ...todos,
      [selectedDateKey]: (todos[selectedDateKey] ?? selectedTodo).map((item) => item.id === id ? { ...item, done: !item.done } : item)
    }));
  };
  const addTodo = () => {
    const text = newTodoText.trim();
    if (!text) return;
    setCustomTodos((todos) => ({
      ...todos,
      [selectedDateKey]: [...(todos[selectedDateKey] ?? selectedTodo), { id: `${Date.now()}`, text, done: false }]
    }));
    setNewTodoText("");
  };
  const deleteTodo = (id: string) => {
    setCustomTodos((todos) => ({
      ...todos,
      [selectedDateKey]: (todos[selectedDateKey] ?? selectedTodo).filter((item) => item.id !== id)
    }));
  };

  return (
    <section className="home-dashboard">
      <div className="hero-row">
        <div>
          <h1>{greeting}，FocusLens</h1>
          <p>{query ? `正在筛选“${searchQuery.trim()}”相关的错题和知识点。` : "今天的学习状态、AI 辅导和错题薄弱点都在这里。"}</p>
        </div>
        <div className="hero-actions">
          <button className="dark-action" onClick={onTutor} disabled={aiBusy}><HelpCircle size={18} />截题并求助</button>
          <button className="layout-action" type="button" onClick={() => setLayoutSettingsOpen(true)}><Settings size={18} />布局设置</button>
        </div>
      </div>

      <section className="dashboard-mosaic">
        {isVisible("focus") && <article {...cardProps("focus", "dose-card")}>
          <div className="focus-command-head"><div className="mini-label"><Clock size={16} />今日学习状态</div><span>{today.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</span></div>
          <div className="focus-command-grid">
            <section className="focus-time-block">
              <span>专注时长</span>
              <strong>{minutes}<em>分钟</em></strong>
              <p>{fusedReason}</p>
              <div className="focus-goal-row"><span>专注进度</span><b>{activePercent}%</b></div>
              <div className="soft-progress"><span style={{ width: `${activePercent}%` }} /></div>
            </section>
            <section className="focus-live-block">
              <span>当前状态</span>
              <strong><i />{stateLabel(fusedState)}</strong>
              <dl>
                <div><dt>摄像头</dt><dd>{isVisionOn ? "运行正常" : "尚未启动"}</dd></div>
                <div><dt>书写活跃度</dt><dd>{writingSignal.motionScore.toFixed(1)}</dd></div>
                <div><dt>今日 AI 辅导</dt><dd>{costs.todayCalls} 次</dd></div>
              </dl>
            </section>
            <section className="focus-action-block">
              <button onClick={onStartVision} disabled={isVisionOn}><Camera size={18} />{isVisionOn ? "摄像头已启动" : "启动摄像头"}</button>
              <button className="ghost" onClick={onStartSession} disabled={isSessionActive}><Play size={18} />{isSessionActive ? "学习进行中" : "开始学习"}</button>
              <small>启动后将同步记录专注、书写与学习时间线。</small>
            </section>
          </div>
          {showQuickCards && (
            <div className={`quick-card-grid ${quickDensity}`}>
              <div><span>AI 调用</span><strong>{costs.todayCalls}</strong></div>
              <div><span>最近错题</span><strong>{latestMistakes.length}</strong></div>
              <div><span>薄弱点</span><strong>{weakPoints.length}</strong></div>
            </div>
          )}
        </article>}

        {isVisible("calendar") && <article {...cardProps("calendar", "calendar-card")}>
          <div className="card-title">
            <span><Calendar size={17} />学习日历</span>
            <button className="text-button" type="button" onClick={onOpenCalendar}>打开月历</button>
          </div>
          <div className="week-strip">
            {week.map((date) => {
              const isToday = date.toDateString() === today.toDateString();
              const key = dateKey(date);
              const isSelected = key === selectedDateKey;
              return (
                <button type="button" className={`day-chip ${isSelected ? "selected" : isToday ? "today" : ""}`} key={key} onClick={() => openTodoForDate(key)}>
                  <span>{["日", "一", "二", "三", "四", "五", "六"][date.getDay()]}</span>
                  <strong>{date.getDate()}</strong>
                </button>
              );
            })}
          </div>
          <div className="appointment-list">
            <div><Brain size={18} /><span>融合状态</span><strong>{stateLabel(fusedState)}</strong></div>
            <div><BookOpen size={18} /><span>书写活跃度</span><strong>{writingSignal.motionScore.toFixed(1)}</strong></div>
          </div>
          <div className="calendar-todo-panel">
            <div className="calendar-todo-head">
              <span>{selectedDate.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} To do</span>
              <small>{selectedTodo.filter((item) => item.done).length}/{selectedTodo.length} 完成</small>
            </div>
            <div className="todo-add-row compact">
              <input value={newTodoText} onChange={(event) => setNewTodoText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTodo(); }} placeholder="新增一条今日任务" />
              <button type="button" onClick={addTodo}>添加</button>
            </div>
            <div className="calendar-todo-list">
              {selectedTodo.map((item) => (
                <div className={item.done ? "todo-row compact done" : "todo-row compact"} key={item.id}>
                  <button type="button" className="todo-check" aria-label="切换完成状态" onClick={() => toggleTodo(item.id)} />
                  <p>{item.text}</p>
                  <button type="button" className="todo-delete" aria-label="删除任务" onClick={() => deleteTodo(item.id)}><X size={15} /></button>
                </div>
              ))}
              {!selectedTodo.length && <p className="todo-empty">这一天还没有任务。</p>}
            </div>
          </div>
        </article>}

        {isVisible("weakness") && <article {...cardProps("weakness", "alert-card")}>
          <div className="card-title">
            <span><AlertCircle size={17} />薄弱提醒</span>
            <button className="text-button" onClick={onOpenMistakes}>查看全部</button>
          </div>
          {(weakPoints.length ? weakPoints : [{ knowledgePoint: query ? "没有匹配的知识点" : "暂无知识点", subject: query ? "搜索" : "待积累", count: 0, isHot: false, markdown: "" }]).map((item) => (
            <div className="alert-row" key={`${item.subject}-${item.knowledgePoint}`}>
              <span className={item.isHot ? "warn-dot hot" : "warn-dot"} />
              <strong>{item.knowledgePoint}</strong>
              <em>{item.subject} · {item.count} 次</em>
            </div>
          ))}
        </article>}

        {isVisible("heatmap") && <article {...cardProps("heatmap", "heatmap-card")}>
          <div className="card-title">
            <span><Calendar size={17} />本月热力图</span>
            <div className="segmented">
              <button className={heatmapMetric === "focus" ? "active" : ""} type="button" onClick={() => setHeatmapMetric("focus")}>专注</button>
              <button className={heatmapMetric === "writing" ? "active" : ""} type="button" onClick={() => setHeatmapMetric("writing")}>书写</button>
              <button className={heatmapMetric === "questions" ? "active" : ""} type="button" onClick={() => setHeatmapMetric("questions")}>提问</button>
            </div>
          </div>
          <MonthHeatmap samples={samples} mistakes={mistakes} today={today} metric={heatmapMetric} />
        </article>}

        {isVisible("weekly") && <article {...cardProps("weekly", "adherence-card")}>
          <div className="card-title"><span><Award size={17} />一周学习分布</span><small>按学习采样量对比每天节奏</small></div>
          <div className="bar-week">
            {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => {
              const sampleCount = samples.filter((sample) => new Date(sample.ts).getDay() === index).length;
              const height = Math.max(24, Math.min(96, sampleCount * 3 || (index === today.getDay() ? summary.score : 28)));
              return <div key={day}><span style={{ height }} /><em>{day}</em></div>;
            })}
          </div>
        </article>}

        {isVisible("costs") && <article {...cardProps("costs", "cost-overview")}>
          <div className="card-title"><span><CircleDollarSign size={17} />AI 费用</span></div>
          <div className="cost-inline">
            <Metric label="今日调用" value={costs.todayCalls.toString()} />
            <Metric label="今日估算" value={`$${costs.todayEstimatedUsd.toFixed(3)}`} />
            <Metric label="本周估算" value={`$${costs.weekEstimatedUsd.toFixed(3)}`} />
          </div>
        </article>}

        {isVisible("timeline") && <article {...cardProps("timeline", "timeline-card")}>
          <div className="card-title">
            <span><Clock size={17} />今日时间线</span>
            <small>{summary.durationSec}s</small>
          </div>
          <Timeline samples={todaySamples} />
          <div className="latest-list">
            {latestMistakes.length ? latestMistakes.map((entry) => (
              <div key={entry.id}>
                <BookOpen size={16} />
                <span>{entry.knowledgePoint || "未归类知识点"}</span>
                <strong>{normalizeSubject(entry.subject)}</strong>
              </div>
            )) : <p>{todaySamples.length ? "今日暂无错题记录。" : "今天还没有开始学习，时间线会在开始后更新。"}</p>}
          </div>
        </article>}
      </section>

      {todoOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setTodoOpen(false)}>
          <section className="todo-modal" role="dialog" aria-modal="true" aria-label="To do list" onClick={(event) => event.stopPropagation()}>
            <div className="todo-head modal-head">
              <strong>{selectedDate.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} To do</strong>
              <button type="button" className="ghost" onClick={() => setTodoOpen(false)}>关闭</button>
            </div>
            <div className="todo-add-row">
              <input value={newTodoText} onChange={(event) => setNewTodoText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTodo(); }} placeholder="新增一条任务，例如：朗读、语文、数学" />
              <button type="button" onClick={addTodo}>添加</button>
            </div>
            {selectedTodo.map((item) => (
              <div className={item.done ? "todo-row done" : "todo-row"} key={item.id}>
                <button type="button" className="todo-check" aria-label="切换完成状态" onClick={() => toggleTodo(item.id)} />
                <p>{item.text}</p>
                <button type="button" className="todo-delete" aria-label="删除任务" onClick={() => deleteTodo(item.id)}><X size={16} /></button>
              </div>
            ))}
          </section>
        </div>
      )}

      {layoutSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setLayoutSettingsOpen(false)}>
          <section className="layout-modal" role="dialog" aria-modal="true" aria-label="Dashboard 布局设置" onClick={(event) => event.stopPropagation()}>
            <div className="todo-head modal-head">
              <strong>Dashboard 布局设置</strong>
              <button type="button" className="ghost" onClick={() => setLayoutSettingsOpen(false)}>关闭</button>
            </div>
            <div className="layout-card-list">
              {dashboardLayout.map((card) => (
                <div className="layout-card-row" key={card.id}>
                  <label><input type="checkbox" checked={card.visible} onChange={() => toggleCard(card.id)} />{dashboardCardLabels[card.id]}</label>
                  <div className="size-buttons">
                    {(["small", "medium", "large", "wide"] as DashboardCardSize[]).map((size) => (
                      <button key={size} type="button" className={card.size === size ? "active" : ""} onClick={() => updateCardSize(card.id, size)}>
                        {sizeLabel(size)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <button className="ghost" type="button" onClick={resetLayout}>恢复默认布局</button>
          </section>
        </div>
      )}
    </section>
  );
}

function CalendarPage({
  samples,
  mistakes,
  summary,
  onOpenMonitor,
  onOpenMistakes,
  onRecognizeMemo
}: {
  samples: SessionSample[];
  mistakes: MistakeEntry[];
  summary: ReturnType<typeof summarizeSession>;
  onOpenMonitor: () => void;
  onOpenMistakes: () => void;
  onRecognizeMemo: (selectedDate: string) => Promise<string[]>;
}) {
  const today = new Date();
  const todayKey = dateKey(today);
  const [monthCursor, setMonthCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [customTodos, setCustomTodos] = useState<Record<string, DashboardTodo[]>>(loadCalendarTodos);
  const [newTodoText, setNewTodoText] = useState("");
  const [memoBusy, setMemoBusy] = useState(false);
  const [memoMessage, setMemoMessage] = useState("");
  const selectedDate = parseDateKey(selectedKey);
  const selectedTodos = customTodos[selectedKey] ?? [];
  const monthDays = buildCalendarMonth(monthCursor);
  const monthLabel = monthCursor.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
  const selectedSamples = samples.filter((sample) => dateKey(new Date(sample.ts)) === selectedKey);
  const selectedMistakes = mistakes.filter((entry) => dateKey(new Date(entry.createdAt)) === selectedKey);
  const selectedWriting = selectedSamples.filter((sample) => sample.state === "WRITING").length;
  const selectedFocus = selectedSamples.filter((sample) => sample.state === "FOCUSED").length;
  const selectedDayStart = new Date(selectedDate);
  selectedDayStart.setDate(selectedDate.getDate() - selectedDate.getDay());
  const selectedWeek = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(selectedDayStart);
    date.setDate(selectedDayStart.getDate() + index);
    const key = dateKey(date);
    const daySamples = samples.filter((sample) => dateKey(new Date(sample.ts)) === key);
    return {
      key,
      label: ["日", "一", "二", "三", "四", "五", "六"][index],
      total: daySamples.length,
      focused: daySamples.filter((sample) => sample.state === "FOCUSED" || sample.state === "WRITING").length
    };
  });
  const weekPeak = Math.max(1, ...selectedWeek.map((day) => day.total));
  const selectedEvents = [
    ...selectedMistakes.map((entry) => ({
      id: `mistake-${entry.id}`,
      type: "mistake" as const,
      time: new Date(entry.createdAt).getTime(),
      title: entry.knowledgePoint || "AI 辅导与错题记录",
      detail: `${entry.subject || "待分类"} · ${entry.mistakeReason || "等待错因归纳"}`
    })),
    ...selectedSamples.slice(-8).map((sample) => ({
      id: `sample-${sample.ts}`,
      type: "sample" as const,
      time: sample.ts,
      title: stateLabel(sample.state),
      detail: sample.reason
    }))
  ].sort((a, b) => b.time - a.time).slice(0, 8);

  useEffect(() => {
    saveCalendarTodos(customTodos);
  }, [customTodos]);

  const selectDay = (key: string) => {
    setSelectedKey(key);
  };
  const shiftMonth = (delta: number) => {
    setMonthCursor((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };
  const addTodo = () => {
    const text = newTodoText.trim();
    if (!text) return;
    setCustomTodos((todos) => ({
      ...todos,
      [selectedKey]: [...(todos[selectedKey] ?? selectedTodos), { id: `${Date.now()}`, text, done: false }]
    }));
    setNewTodoText("");
  };
  const toggleTodo = (id: string) => {
    setCustomTodos((todos) => ({
      ...todos,
      [selectedKey]: (todos[selectedKey] ?? selectedTodos).map((item) => item.id === id ? { ...item, done: !item.done } : item)
    }));
  };
  const deleteTodo = (id: string) => {
    setCustomTodos((todos) => ({
      ...todos,
      [selectedKey]: (todos[selectedKey] ?? selectedTodos).filter((item) => item.id !== id)
    }));
  };
  const importMemo = async () => {
    setMemoBusy(true);
    setMemoMessage("正在拍摄并识别手写备忘录...");
    try {
      const todos = await onRecognizeMemo(selectedKey);
      setCustomTodos((current) => ({
        ...current,
        [selectedKey]: [
          ...(current[selectedKey] ?? selectedTodos),
          ...todos.map((text, index) => ({ id: `${Date.now()}-${index}`, text, done: false }))
        ]
      }));
      setMemoMessage(`已识别 ${todos.length} 条作业。`);
    } catch (err) {
      setMemoMessage(err instanceof Error ? err.message : "手写备忘录识别失败");
    } finally {
      setMemoBusy(false);
    }
  };

  return (
    <section className="calendar-page">
      <div className="calendar-page-head">
        <div>
          <h1>学习日历</h1>
          <p>按日期查看专注、书写、错题和 To do。</p>
        </div>
        <div className="calendar-nav">
          <button className="ghost" onClick={() => shiftMonth(-1)}>上个月</button>
          <strong>{monthLabel}</strong>
          <button className="ghost" onClick={() => shiftMonth(1)}>下个月</button>
          <button onClick={() => { setMonthCursor(new Date(today.getFullYear(), today.getMonth(), 1)); selectDay(todayKey); }}>回到今天</button>
        </div>
      </div>
      <div className="calendar-workspace">
        <section className="month-board">
          <div className="month-weekdays">
            {["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="month-grid">
            {monthDays.map((date) => {
              const key = dateKey(date);
              const inMonth = date.getMonth() === monthCursor.getMonth();
              const daySamples = samples.filter((sample) => dateKey(new Date(sample.ts)) === key);
              const dayMistakes = mistakes.filter((entry) => dateKey(new Date(entry.createdAt)) === key).length;
              const dayTodos = customTodos[key] ?? [];
              const hasFocus = daySamples.some((sample) => sample.state === "FOCUSED");
              const hasWriting = daySamples.some((sample) => sample.state === "WRITING");
              const dayMarkers = [
                hasFocus ? "紫色：有专注学习采样" : "",
                hasWriting ? "绿色：有书写采样" : "",
                dayMistakes > 0 ? `红色：${dayMistakes} 条错题/AI 记录` : "",
                dayTodos.length > 0 ? `橙色：${dayTodos.length} 条 To do/备忘` : ""
              ].filter(Boolean);
              return (
                <button
                  type="button"
                  className={`month-day ${inMonth ? "" : "muted"} ${key === selectedKey ? "selected" : ""} ${key === todayKey ? "today" : ""}`}
                  key={key}
                  onClick={() => selectDay(key)}
                  title={dayMarkers.length ? dayMarkers.join("；") : "这一天暂无记录"}
                >
                  <span>{date.getDate()}</span>
                  <small>{daySamples.length ? `${daySamples.length} 秒` : " "}</small>
                  <div className="day-dots">
                    {hasFocus && <i className="focus-dot" />}
                    {hasWriting && <i className="writing-dot" />}
                    {dayMistakes > 0 && <i className="mistake-dot" />}
                    {dayTodos.length > 0 && <i className="todo-dot" />}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="calendar-dot-legend" aria-label="日历标记说明">
            <span><i className="focus-dot" />专注采样</span>
            <span><i className="writing-dot" />书写采样</span>
            <span><i className="mistake-dot" />错题/AI 记录</span>
            <span><i className="todo-dot" />To do/备忘</span>
          </div>
        </section>
        <section className="selected-day-strip">
          <div className="calendar-todo-head">
            <span>{selectedDate.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</span>
            <small>{selectedTodos.filter((item) => item.done).length}/{selectedTodos.length} 完成</small>
          </div>
          <div className="summary-grid">
            <button className="metric metric-link" type="button" onClick={onOpenMonitor}><span>专注片段</span><strong>{selectedFocus}</strong></button>
            <button className="metric metric-link" type="button" onClick={onOpenMonitor}><span>书写片段</span><strong>{selectedWriting}</strong></button>
            <button className="metric metric-link" type="button" onClick={onOpenMistakes}><span>错题</span><strong>{selectedMistakes.length}</strong></button>
            <button className="metric metric-link" type="button" onClick={onOpenMonitor}><span>总时长</span><strong>{selectedSamples.length || summary.durationSec}s</strong></button>
          </div>
          <section className="calendar-week-rhythm">
            <div className="calendar-section-head"><strong>本周学习节奏</strong><span>柱高为学习采样，深色为专注与书写</span></div>
            <div className="week-rhythm-bars">
              {selectedWeek.map((day) => (
                <button type="button" key={day.key} className={day.key === selectedKey ? "active" : ""} onClick={() => selectDay(day.key)} title={`${day.total} 秒学习采样`}>
                  <span className="week-rhythm-track">
                    <i style={{ height: `${Math.max(5, (day.total / weekPeak) * 100)}%` }} />
                    <b style={{ height: `${Math.max(0, (day.focused / weekPeak) * 100)}%` }} />
                  </span>
                  <em>{day.label}</em>
                </button>
              ))}
            </div>
          </section>
        </section>
      </div>
      <div className="calendar-lower-workspace">
        <section className="calendar-detail-panel calendar-task-panel">
          <div className="calendar-section-head">
            <div><strong>学习任务</strong><span>安排与完成 {selectedDate.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} 的任务</span></div>
            <button type="button" className="ghost" onClick={importMemo} disabled={memoBusy}><Camera size={16} />{memoBusy ? "识别中" : "拍照识别备忘录"}</button>
          </div>
          <div className="todo-add-row">
            <input value={newTodoText} onChange={(event) => setNewTodoText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTodo(); }} placeholder="新增这一天的任务" />
            <button type="button" onClick={addTodo}>添加任务</button>
          </div>
          {memoMessage && <p className="calendar-inline-message">{memoMessage}</p>}
          <div className="calendar-todo-list large">
            {selectedTodos.length === 0 && <p className="todo-empty">这一天还没有任务，可以手动添加或拍照识别手写备忘录。</p>}
            {selectedTodos.map((item) => (
              <div className={item.done ? "todo-row compact done" : "todo-row compact"} key={item.id}>
                <button type="button" className="todo-check" aria-label="切换完成状态" onClick={() => toggleTodo(item.id)} />
                <p>{item.text}</p>
                <button type="button" className="todo-delete" aria-label="删除任务" onClick={() => deleteTodo(item.id)}><X size={15} /></button>
              </div>
            ))}
          </div>
        </section>
        <section className="calendar-detail-panel">
          <section className="calendar-event-feed">
            <div className="calendar-section-head">
              <div><strong>学习事件</strong><span>专注、书写、AI 辅导与错题记录</span></div>
              <em>{selectedEvents.length} 条</em>
            </div>
            {selectedEvents.length === 0 && <p className="todo-empty">这一天还没有学习或错题记录。</p>}
            {selectedEvents.map((event) => (
              <button type="button" key={event.id} onClick={event.type === "mistake" ? onOpenMistakes : onOpenMonitor}>
                <i className={event.type} />
                <span><strong>{event.title}</strong><small>{event.detail}</small></span>
                <time>{new Date(event.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
              </button>
            ))}
          </section>
        </section>
      </div>
    </section>
  );
}

function MonthHeatmap({ samples, mistakes, today, metric = "focus" }: { samples: SessionSample[]; mistakes: MistakeEntry[]; today: Date; metric?: "focus" | "writing" | "questions" }) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const counts = new Map<string, number>();
  if (metric === "questions") {
    for (const mistake of mistakes) {
      const date = new Date(mistake.createdAt);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  } else {
    for (const sample of samples) {
      const date = new Date(sample.ts);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const value = metric === "writing" && sample.state !== "WRITING" ? 0 : 1;
      counts.set(key, (counts.get(key) ?? 0) + value);
    }
  }
  const cells = [
    ...Array.from({ length: firstDay }, (_, index) => ({ key: `blank-${index}`, day: 0, level: 0 })),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const count = counts.get(`${year}-${month}-${day}`) ?? 0;
      const level = metric === "questions"
        ? count > 6 ? 4 : count > 3 ? 3 : count > 1 ? 2 : count > 0 ? 1 : 0
        : count > 90 ? 4 : count > 45 ? 3 : count > 15 ? 2 : count > 0 ? 1 : 0;
      return { key: `day-${day}`, day, level };
    })
  ];
  return (
    <div className="month-heatmap" aria-label="本月学习热力图">
      <div className="heatmap-head">
        <span>本月热力图</span>
        <small>{metric === "questions" ? "AI 提问越多颜色越深" : "学习采样越多颜色越深"}</small>
      </div>
      <div className="heatmap-grid">
        {cells.map((cell) => (
          <span
            key={cell.key}
            className={cell.day ? `heat-cell level-${cell.level}` : "heat-cell blank"}
            title={cell.day ? `${month + 1}月${cell.day}日` : ""}
          />
        ))}
      </div>
    </div>
  );
}

function getTimeGreeting(date: Date) {
  const hour = date.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function parseDateKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function buildCalendarMonth(cursor: Date) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function buildDashboardTodos(selectedKey: string, todayKey: string, weakCount: number, mistakeCount: number, aiCalls: number) {
  const isToday = selectedKey === todayKey;
  return [
    { id: "monitor", text: isToday ? "启动一次学习监控，记录今天的专注曲线" : "查看当天学习记录", done: false },
    { id: "weak", text: weakCount > 0 ? `复习 ${weakCount} 个高频薄弱知识点` : "暂无高频薄弱点，保持观察", done: weakCount === 0 },
    { id: "mistake", text: mistakeCount > 0 ? `订正最近 ${mistakeCount} 道错题` : "暂无待订正错题", done: mistakeCount === 0 },
    { id: "ai", text: aiCalls > 0 ? `检查今日 ${aiCalls} 次 AI 辅导记录` : "需要时用 F8 截题求助", done: aiCalls > 0 }
  ];
}

function sizeLabel(size: DashboardCardSize) {
  return { small: "三分之一", medium: "半行", large: "三分之二", wide: "整行" }[size];
}

function loadDashboardLayout(): DashboardCardConfig[] {
  try {
    const raw = localStorage.getItem("focuslens_v2_dashboard_layout_v3");
    if (!raw) return defaultDashboardLayout;
    const parsed = JSON.parse(raw) as DashboardCardConfig[];
    const known = new Map(parsed.map((card) => [card.id, card]));
    return defaultDashboardLayout.map((fallback) => {
      const saved = known.get(fallback.id);
      return saved ? { ...fallback, ...saved } : fallback;
    }).sort((a, b) => {
      const aIndex = parsed.findIndex((card) => card.id === a.id);
      const bIndex = parsed.findIndex((card) => card.id === b.id);
      return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex);
    });
  } catch {
    return defaultDashboardLayout;
  }
}

function saveDashboardLayout(layout: DashboardCardConfig[]) {
  localStorage.setItem("focuslens_v2_dashboard_layout_v3", JSON.stringify(layout));
}

function loadDashboardTodos(): Record<string, DashboardTodo[]> {
  try {
    const raw = localStorage.getItem("focuslens_v2_dashboard_todos");
    return raw ? JSON.parse(raw) as Record<string, DashboardTodo[]> : {};
  } catch {
    return {};
  }
}

function saveDashboardTodos(todos: Record<string, DashboardTodo[]>) {
  localStorage.setItem("focuslens_v2_dashboard_todos", JSON.stringify(todos));
}

function loadCalendarTodos(): Record<string, DashboardTodo[]> {
  try {
    const raw = localStorage.getItem("focuslens_v2_calendar_todos");
    return raw ? JSON.parse(raw) as Record<string, DashboardTodo[]> : {};
  } catch {
    return {};
  }
}

function saveCalendarTodos(todos: Record<string, DashboardTodo[]>) {
  localStorage.setItem("focuslens_v2_calendar_todos", JSON.stringify(todos));
}

function loadCustomSubjects(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SUBJECTS_KEY);
    return raw ? JSON.parse(raw) as string[] : [];
  } catch {
    return [];
  }
}

function saveCustomSubjects(subjects: string[]) {
  localStorage.setItem(CUSTOM_SUBJECTS_KEY, JSON.stringify(subjects));
}

function buildSubjectOptions(mistakes: MistakeEntry[], wiki: KnowledgeWiki[], customSubjects: string[]) {
  const subjects = new Set(DEFAULT_SUBJECT_OPTIONS);
  for (const subject of customSubjects) {
    const normalized = normalizeSubject(subject);
    if (normalized) subjects.add(normalized);
  }
  for (const entry of mistakes) {
    const normalized = normalizeSubject(entry.subject);
    if (normalized) subjects.add(normalized);
  }
  for (const item of wiki) {
    const normalized = normalizeSubject(item.subject);
    if (normalized) subjects.add(normalized);
  }
  return Array.from(subjects);
}

function reorderDashboardCards(layout: DashboardCardConfig[], from: DashboardCardId, to: DashboardCardId) {
  const next = [...layout];
  const fromIndex = next.findIndex((card) => card.id === from);
  const toIndex = next.findIndex((card) => card.id === to);
  if (fromIndex < 0 || toIndex < 0) return layout;
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function MonitorPage({
  frontVideoRef,
  frontCanvasRef,
  paperVideoRef,
  paperCanvasRef,
  frontSignal,
  writingSignal,
  fusedState,
  fusedReason,
  samples,
  summary,
  reminderEnabled,
  setReminderEnabled,
  reminderRecording,
  customReminderUrl,
  playReminder,
  toggleReminderRecording,
  clearCustomReminder,
  aiConfig,
  setAiConfig,
  bgMusicUrl,
  setBgMusicUrl,
  bgMusicPlaying,
  toggleBgMusic
}: {
  frontVideoRef: React.RefObject<HTMLVideoElement | null>;
  frontCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  paperVideoRef: React.RefObject<HTMLVideoElement | null>;
  paperCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  frontSignal: FrontSignal;
  writingSignal: WritingSignal;
  fusedState: LearningState;
  fusedReason: string;
  samples: SessionSample[];
  summary: ReturnType<typeof summarizeSession>;
  reminderEnabled: boolean;
  setReminderEnabled: (value: boolean) => void;
  reminderRecording: boolean;
  customReminderUrl: string;
  playReminder: () => void;
  toggleReminderRecording: () => void;
  clearCustomReminder: () => void;
  aiConfig: AiConfig;
  setAiConfig: (config: AiConfig) => void;
  bgMusicUrl: string;
  setBgMusicUrl: (value: string) => void;
  bgMusicPlaying: boolean;
  toggleBgMusic: () => void;
}) {
  return (
    <section className="monitor-workspace">
      <div className="monitor-heading">
        <div><h2>学习监控</h2><p>正面专注与俯拍书写联合判断，状态变化会记录到学习日历。</p></div>
        <div className={`monitor-live-pill ${fusedState.toLowerCase()}`}><i />{stateLabel(fusedState)} · {summary.durationSec}s</div>
      </div>
      <section className="monitor-camera-grid">
        <Panel title="正面专注追踪" icon={<Camera size={18} />} className="monitor-camera-panel">
          <video ref={frontVideoRef} className="hidden-video" />
          <div className="monitor-video-frame">
            <canvas ref={frontCanvasRef} width={640} height={480} className="camera-canvas" />
            <div className={`camera-state-overlay ${frontSignal.state.toLowerCase()}`}><strong>{stateLabel(frontSignal.state)}</strong><span>{frontSignal.reason}</span></div>
          </div>
          <div className="camera-signal-row"><span>视线与头部状态</span><strong>{stateLabel(frontSignal.state)}</strong></div>
        </Panel>

        <Panel title="俯拍书写检测" icon={<BookOpen size={18} />} className="monitor-camera-panel">
          <video ref={paperVideoRef} className="hidden-video" />
          <div className="monitor-video-frame">
            <canvas ref={paperCanvasRef} width={1280} height={720} className="camera-canvas paper" />
            <div className={`camera-state-overlay ${writingSignal.active ? "writing" : "thinking"}`}><strong>{writingSignal.active ? "书写" : "阅读 / 思考"}</strong><span>{writingSignal.active ? "检测到卷面局部变化" : "等待书写或阅读思考"}</span></div>
          </div>
          <div className="camera-signal-row"><span>书写活跃度</span><strong>{writingSignal.motionScore.toFixed(1)}</strong></div>
          <div className="meter"><span style={{ width: `${Math.min(100, writingSignal.motionScore * 4)}%` }} /></div>
        </Panel>
      </section>

      <Panel title="俯拍截图范围与对焦" icon={<Settings size={18} />} className="monitor-tools-panel">
        <div className="live-camera-tools">
          <CaptureRegionControls config={aiConfig} onConfig={setAiConfig} />
          <FocusControls config={aiConfig} onConfig={setAiConfig} />
        </div>
      </Panel>

      <section className="monitor-lower-grid">
        <Panel title="融合状态与实时记录" icon={<Brain size={18} />} className="monitor-fusion-panel">
        <div className={`state-card ${fusedState.toLowerCase()}`}>
          <span>{stateLabel(fusedState)}</span>
          <strong>{fusedReason}</strong>
        </div>
        <div className="summary-grid">
          <Metric label="得分" value={summary.score.toString()} />
          <Metric label="时长" value={`${summary.durationSec}s`} />
          <Metric label="书写" value={`${summary.counts.WRITING}s`} />
          <Metric label="停滞" value={`${summary.counts.STALLED}s`} />
        </div>
        <Timeline samples={samples} />
        <div className="monitor-event-list">
          {(samples.length ? samples.slice(-4).reverse() : [{ ts: Date.now(), state: fusedState, reason: "等待开始学习", motionScore: 0 }]).map((sample, index) => (
            <div key={`${sample.ts}-${index}`}><i className={sample.state.toLowerCase()} /><span>{new Date(sample.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><strong>{stateLabel(sample.state)}</strong><em>{sample.reason}</em></div>
          ))}
        </div>
        </Panel>

        <Panel title="声音提醒与学习环境" icon={<Volume2 size={18} />} className="monitor-sound-panel">
        <div className="sound-settings">
          <label className="check"><input type="checkbox" checked={reminderEnabled} onChange={(event) => setReminderEnabled(event.target.checked)} />走神/停滞时播放提醒音</label>
          <div className="button-row">
            <button type="button" className="ghost" onClick={playReminder}><Volume2 size={18} />测试提醒</button>
            <button type="button" onClick={toggleReminderRecording}>{reminderRecording ? <Square size={18} /> : <Mic size={18} />}{reminderRecording ? "停止录音" : customReminderUrl ? "重录提醒" : "录制提醒"}</button>
            {customReminderUrl && <button type="button" className="ghost danger" onClick={clearCustomReminder}><X size={18} />删除录音</button>}
          </div>
          {customReminderUrl && <audio controls src={customReminderUrl} />}
          <label className="device-select">
            <span>背景音乐文件</span>
            <input type="file" accept="audio/*" onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (bgMusicUrl) URL.revokeObjectURL(bgMusicUrl);
              setBgMusicUrl(URL.createObjectURL(file));
            }} />
          </label>
          <button type="button" className="ghost" onClick={toggleBgMusic} disabled={!bgMusicUrl}>{bgMusicPlaying ? <Pause size={18} /> : <Play size={18} />}{bgMusicPlaying ? "暂停背景音乐" : "播放背景音乐"}</button>
        </div>
        </Panel>
      </section>
    </section>
  );
}

function TutorPage({
  paperCanvasRef,
  studentQuestion,
  recording,
  wakeListening,
  wakeStatus,
  wakeTranscript,
  teacherName,
  recordQuestion,
  startWakeListening,
  triggerTutor,
  startCaptureAskListening,
  finishCaptureAskListening,
  followUpQuestion,
  finishFollowUpListening,
  aiBusy,
  tutorAnswer,
  tutorFinalAnswer,
  currentEvent,
  learningEvents,
  revealAnswer,
  promoteEvent,
  selectEvent,
  speakAnswer,
  conversationMode,
  setConversationMode,
  speechStatus
}: {
  paperCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  studentQuestion: string;
  recording: boolean;
  wakeListening: boolean;
  wakeStatus: string;
  wakeTranscript: string;
  teacherName: string;
  recordQuestion: () => void;
  startWakeListening: () => void;
  triggerTutor: (trigger?: "manual" | "care_offer", overrideQuestion?: string) => void;
  startCaptureAskListening: () => void;
  finishCaptureAskListening: () => void;
  followUpQuestion: () => void;
  finishFollowUpListening: () => void;
  aiBusy: boolean;
  tutorAnswer: string;
  tutorFinalAnswer: string;
  currentEvent: LearningEvent | null;
  learningEvents: LearningEvent[];
  revealAnswer: () => void;
  promoteEvent: () => void;
  selectEvent: (event: LearningEvent) => void;
  speakAnswer: (markdown?: string | unknown, listenAfter?: boolean) => void;
  conversationMode: boolean;
  setConversationMode: (value: boolean) => void;
  speechStatus: string;
}) {
  const voicePhase = aiBusy ? "thinking" : recording ? "listening" : speechStatus.includes("播放") || speechStatus.includes("朗读") ? "speaking" : tutorAnswer ? "followup" : "ready";
  return (
    <section className="tutor-workspace">
      <div className="tutor-page-heading">
        <div><span className="eyebrow">VOICE FIRST</span><h2>AI 教师</h2><p>孩子可以不看屏幕。按住说话，松开后由老师理解并语音讲解。</p></div>
        <div className={`tutor-live-status ${voicePhase}`}><i />{voicePhaseLabel(voicePhase)}</div>
      </div>
      <div className="tutor-workbench">
        <Panel title="当前题目" icon={<Camera size={18} />} className="tutor-question-panel">
          <TutorQuestionPreview canvasRef={paperCanvasRef} />
          <div className="tutor-capture-note"><strong>俯拍题目画面</strong><span>F8 可在截题同时说“第 33 题”或补充卡住的位置。</span></div>
          <button
            className="tutor-primary-voice"
            onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); startCaptureAskListening(); }}
            onPointerUp={finishCaptureAskListening}
            onPointerCancel={finishCaptureAskListening}
            onPointerLeave={finishCaptureAskListening}
            onClick={(event) => event.preventDefault()}
            disabled={aiBusy}
          ><Camera size={20} />{aiBusy ? "正在理解题目" : "按住截题并求助（F8）"}</button>
          <div className="transcript-box tutor-transcript"><span>孩子刚才说</span><strong>{wakeTranscript || studentQuestion || "还没有识别到语音。按住按钮说话，松开结束。"}</strong></div>
        </Panel>

        <Panel title="语音辅导" icon={<Mic size={18} />} className="tutor-conversation-panel">
          <VoiceInteractionTimeline phase={voicePhase} />
          <div className={`voice-orb ${voicePhase}`}><Mic size={28} /><span>{voicePhaseLabel(voicePhase)}</span></div>
          <div className="tutor-voice-actions">
            <button
              onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); recordQuestion(); }}
              onPointerUp={finishFollowUpListening}
              onPointerCancel={finishFollowUpListening}
              onPointerLeave={finishFollowUpListening}
              onClick={(event) => event.preventDefault()}
              disabled={aiBusy}
            >{recording ? <Square size={18} /> : <Mic size={18} />}{recording ? "松开结束" : "按住语音提问（F10）"}</button>
            <button
              className="ghost"
              onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); followUpQuestion(); }}
              onPointerUp={finishFollowUpListening}
              onPointerCancel={finishFollowUpListening}
              onPointerLeave={finishFollowUpListening}
              onClick={(event) => event.preventDefault()}
              disabled={aiBusy || (!currentEvent && !learningEvents.length)}
            ><Mic size={18} />按住上下文追问（F9）</button>
          </div>
          <div className="tutor-answer-head"><strong>老师正在讲解</strong><div><button className="ghost" onClick={speakAnswer} disabled={!tutorAnswer}><Volume2 size={16} />重播重点</button><button className="ghost" onClick={() => window.speechSynthesis?.cancel()}><Square size={16} />停止朗读</button></div></div>
          <div className="answer-box tutor-answer" dangerouslySetInnerHTML={{ __html: tutorAnswer ? renderMathMarkdown(tutorAnswer) : "<p>回答会流式显示在这里，并优先通过语音讲出关键提示。老师会先引导思路，默认不直接给最终答案。</p>" }} />
          {currentEvent && tutorFinalAnswer && (
            <div className="tutor-final-answer">
              <div className="tutor-answer-head"><strong>完整解法与结论</strong>{!currentEvent.answerRevealed && <button type="button" className="ghost" onClick={revealAnswer}><Eye size={16} />查看完整解法</button>}</div>
              {currentEvent.answerRevealed
                ? <div className="answer-box" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(tutorFinalAnswer) }} />
                : <div className="final-answer-locked">完整推导步骤与最终结论已保存到学习事件中，点击后显示；不会只给出一个直接答案。</div>}
            </div>
          )}
        </Panel>

        <Panel title="本轮上下文" icon={<Brain size={18} />} className="tutor-context-panel">
          <ContextRow label="老师称呼" value={teacherName || "小老师"} />
          <ContextRow label="交互方式" value="按压说话，松开结束" />
          <ContextRow label="当前状态" value={voicePhaseLabel(voicePhase)} />
          <div className="wake-card compact">
            <strong>语音唤醒</strong>
            <span>喊“{teacherName || "小老师"}”后启动；浏览器唤醒不稳定时建议使用 F8/F9/F10 或蓝牙按键。</span>
            <em className={wakeListening ? "wake-live" : ""}>{wakeStatus}</em>
            <button className="ghost" onClick={startWakeListening}>{wakeListening ? <Square size={16} /> : <Mic size={16} />}{wakeListening ? "停止唤醒" : "开启唤醒"}</button>
          </div>
          <label className="check tutor-follow-switch"><input type="checkbox" checked={conversationMode} onChange={(event) => setConversationMode(event.target.checked)} />AI 讲完后提示继续追问</label>
          <div className="speech-status">{speechStatus}</div>
          <div className="followup-boundary-note"><strong>追问默认接上最近问题</strong><span>F9 会追问当前选中事件；未选择时自动接上最近一次学习事件，不会新建知识点。</span></div>
          <button className="ghost" onClick={promoteEvent} disabled={!currentEvent}><BookOpen size={16} />整理为知识页</button>
          <button className="ghost" onClick={() => speakAnswer("语音测试。我是小老师，现在可以听到我的声音吗？")}><Volume2 size={16} />测试语音播放</button>
          <div className="event-history">
            <div className="section-head compact-head"><strong>学习事件</strong><small>{currentEvent ? "追问将更新当前事件" : learningEvents.length ? "未选择时默认追问最近事件" : "先用 F8/F10 创建事件"}</small></div>
            {learningEvents.slice(0, 8).map((event) => (
              <button type="button" key={event.id} className={currentEvent?.id === event.id ? "active" : ""} onClick={() => selectEvent(event)}>
                <span className="event-subject">{event.subject || (event.interactionMode === "voice" ? "语音问答" : "待分类")}</span>
                <strong className="event-title">{event.questionText || event.originalQuestion}</strong>
                <small className="event-meta">{new Date(event.updatedAt).toLocaleString("zh-CN")}{event.followUps.length ? ` · ${event.followUps.length} 次追问` : ""}</small>
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function voicePhaseLabel(phase: string) {
  return { ready: "等待提问", listening: "正在听孩子说话", thinking: "正在理解并组织提示", speaking: "正在语音讲解", followup: "等待上下文追问" }[phase] ?? "等待提问";
}

function VoiceInteractionTimeline({ phase }: { phase: string }) {
  const steps = [["listening", "听见问题"], ["thinking", "理解题目"], ["speaking", "语音讲解"], ["followup", "等待追问"]];
  const activeIndex = phase === "ready" ? -1 : steps.findIndex(([id]) => id === phase);
  return <div className="voice-timeline">{steps.map(([id, label], index) => <div key={id} className={index < activeIndex ? "done" : index === activeIndex ? "active" : ""}><i>{index < activeIndex ? "✓" : index + 1}</i><span>{label}</span></div>)}</div>;
}

function TutorQuestionPreview({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const [image, setImage] = useState("");
  useEffect(() => {
    const update = () => {
      try {
        const canvas = canvasRef.current;
        if (canvas?.width && canvas?.height) setImage(canvas.toDataURL("image/jpeg", 0.72));
      } catch { /* camera may not be ready */ }
    };
    update();
    const timer = window.setInterval(update, 1800);
    return () => window.clearInterval(timer);
  }, [canvasRef]);
  return <div className="tutor-question-preview">{image ? <img src={image} alt="俯拍题目预览" /> : <div><Camera size={28} /><span>启动俯拍摄像头后，这里会显示当前题目。</span></div>}<span className="capture-frame-preview">AI 截图范围</span></div>;
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return <div className="tutor-context-row"><span>{label}</span><strong>{value}</strong></div>;
}

function ParentConsolePage({ baseUrl }: { baseUrl: string }) {
  const [state, setState] = useState<ParentState | null>(null);
  const [message, setMessage] = useState("请回到当前学习任务。");
  const [status, setStatus] = useState("正在连接 FocusLens 后端...");
  const [busy, setBusy] = useState(false);

  // Notification states and refs
  const [notificationPermission, setNotificationPermission] = useState<
    "default" | "granted" | "denied" | "unsupported"
  >("Notification" in window ? Notification.permission : "unsupported");

  const lastStateRef = useRef<string | null>(null);
  const lastAbsentRef = useRef<boolean | null>(null);

  const requestNotificationPermission = async () => {
    if (!("Notification" in window)) return;
    try {
      const result = await Notification.requestPermission();
      setNotificationPermission(result);
      if (result === "granted") {
        // Trigger a test alert
        try {
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = "sine";
          osc.frequency.value = 880;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0, audioCtx.currentTime);
          gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
          osc.start(audioCtx.currentTime);
          osc.stop(audioCtx.currentTime + 0.3);
        } catch {}

        new Notification("FocusLens 提醒已开启", {
          body: "当孩子学习状态异常时，您会在此收到推送通知。"
        });
      }
    } catch (err) {
      console.error("Failed to request notification permission", err);
    }
  };

  const triggerParentAlert = (title: string, body: string) => {
    // 1. System notification
    if ("Notification" in window && Notification.permission === "granted") {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body,
            icon: "/favicon.ico",
            tag: "focuslens-parent-alert",
            renotify: true
          } as any);
        }).catch(() => {
          new Notification(title, { body });
        });
      } else {
        new Notification(title, { body });
      }
    }

    // 2. Sound (Web Audio oscillator beep warning)
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const playBeep = (delay: number, frequency: number, duration: number) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = frequency;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, audioCtx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + delay + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + delay + duration);
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + duration);
      };
      playBeep(0, 880, 0.3);
      playBeep(0.4, 880, 0.3);
    } catch {}

    // 3. Vibration
    if ("vibrate" in navigator) {
      navigator.vibrate([300, 100, 300, 100, 300]);
    }
  };

  const refresh = async () => {
    try {
      const next = await fetchParentStatus(baseUrl);
      setState(next);
      setStatus("已连接");

      const student = next.student;
      const settings = next.settings;
      if (student && settings) {
        const currentState = student.learningState;
        const currentAbsent = student.absent;

        if (lastStateRef.current !== null) {
          // 1. Check Distracted (走神)
          if (settings.driftReminderEnabled && currentState === "DISTRACTED" && lastStateRef.current !== "DISTRACTED") {
            triggerParentAlert("走神提醒", `孩子可能走神了：${student.reason || '检测到偏头或视线偏离'}`);
          }
          // 2. Check Stalled (停滞)
          if (settings.idleReminderEnabled && currentState === "STALLED" && lastStateRef.current !== "STALLED") {
            triggerParentAlert("停滞提醒", `孩子已长时间没有书写动作：${student.reason || '可能遇到难题卡住了'}`);
          }
          // 3. Check Absent (离座)
          if (settings.absentReminderEnabled && currentAbsent && !lastAbsentRef.current) {
            triggerParentAlert("离座提醒", "孩子离开座位了");
          }
        } else {
          // Initialize values on first successful load
          lastStateRef.current = currentState;
          lastAbsentRef.current = currentAbsent;
        }

        lastStateRef.current = currentState;
        lastAbsentRef.current = currentAbsent;
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "无法连接家长端服务");
    }
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [baseUrl]);

  async function saveSettings(settings: ParentSettings) {
    setBusy(true);
    try {
      const next = await updateParentSettings(baseUrl, settings);
      setState(next);
      setStatus("设置已保存");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "设置保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function sendReminder(type: ParentReminder["type"], text = message) {
    setBusy(true);
    try {
      const next = await createParentReminder(baseUrl, type, text);
      setState(next);
      setStatus("提醒已发送到学生端");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "提醒发送失败");
    } finally {
      setBusy(false);
    }
  }

  const settings = state?.settings;
  const student = state?.student;
  const updatedAt = student?.updatedAt ? new Date(student.updatedAt).toLocaleString("zh-CN") : "尚未收到学生端状态";

  // Calculate session summary for the parent console timeline
  const summary = useMemo(() => summarizeSession(student?.samples || []), [student?.samples]);

  return (
    <main className="parent-console">
      <section className="parent-phone-shell">
        <header className="parent-console-hero">
          <span>FocusLens Parent</span>
          <h1>家长手机端</h1>
          <p>同一局域网内查看孩子学习状态，发送温和提醒，并控制 AI 教师是否可用。</p>
          <em>{status}</em>
        </header>

        {notificationPermission === "default" && (
          <div className="parent-notification-banner" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '16px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#1e40af', fontWeight: 'bold' }}>
              <AlertCircle size={20} />
              <span>开启提醒推送通知</span>
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: '#1e3a8a', lineHeight: '1.5' }}>
              当孩子走神、长时间不书写或离座时，允许通知可以使您在手机息屏状态下也能接收到实时蜂鸣和震动推送。
            </p>
            <button onClick={requestNotificationPermission} style={{ background: '#2563eb', color: 'white', border: 0, borderRadius: '10px', padding: '10px 16px', fontWeight: 'bold', cursor: 'pointer', transition: 'background 0.2s' }}>
              开启提醒推送
            </button>
          </div>
        )}

        <section className="parent-status-card">
          <div className={student?.learningState ? student.learningState.toLowerCase() : ""}>
            <span>当前状态</span>
            <strong>{student?.learningState ? stateLabel(student.learningState as LearningState) : "未知"}</strong>
            <small>{student?.reason || "等待学生端上报状态"}</small>
          </div>
          <div className={student?.absent ? "distracted" : student?.writingActive ? "focused" : ""}>
            <span>书写与画面</span>
            <strong>{student?.writingActive ? "有书写" : "暂无书写"}</strong>
            <small>{student?.absent ? "学生可能离座" : "学生在画面中"}</small>
          </div>
          <div className={student?.aiBusy ? "reading" : ""}>
            <span>AI 教师</span>
            <strong>{student?.aiBusy ? "正在回答" : settings?.aiTeacherMode === "disabled" ? "已关闭" : settings?.aiTeacherMode === "ask_parent" ? "需确认" : "可使用"}</strong>
            <small>更新：{updatedAt}</small>
          </div>
        </section>

        {student && (
          <section className="parent-control-card monitor-fusion-panel">
            <h2>目前融合状态与实时记录</h2>
            <div className={`state-card ${(student.learningState || "PAUSED").toLowerCase()}`}>
              <span>{stateLabel((student.learningState || "PAUSED") as LearningState)}</span>
              <strong>{student.reason || "等待学生端上报状态"}</strong>
            </div>

            <div className="summary-grid">
              <Metric label="得分" value={summary.score.toString()} />
              <Metric label="时长" value={`${summary.durationSec}s`} />
              <Metric label="书写" value={`${summary.counts.WRITING}s`} />
              <Metric label="停滞" value={`${summary.counts.STALLED}s`} />
            </div>

            <Timeline samples={student.samples || []} />

            <div className="monitor-event-list">
              {((student.samples && student.samples.length) ? student.samples.slice(-4).reverse() : [{ ts: Date.now(), state: (student.learningState || "PAUSED") as LearningState, reason: student.reason || "等待学生端上报状态", motionScore: 0 }]).map((sample, index) => (
                <div key={`${sample.ts}-${index}`}>
                  <i className={sample.state.toLowerCase()} />
                  <span>{new Date(sample.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <strong>{stateLabel(sample.state)}</strong>
                  <em>{sample.reason}</em>
                </div>
              ))}
            </div>
          </section>
        )}

        {settings && (
          <section className="parent-control-card">
            <h2>AI 教师开关</h2>
            <div className="parent-segmented">
              {([
                ["enabled", "允许"],
                ["ask_parent", "需确认"],
                ["disabled", "关闭"]
              ] as Array<[ParentSettings["aiTeacherMode"], string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  className={settings.aiTeacherMode === mode ? "active" : ""}
                  disabled={busy}
                  onClick={() => saveSettings({ ...settings, aiTeacherMode: mode })}
                >
                  {label}
                </button>
              ))}
            </div>

            <h2>提醒开关</h2>
            <div className="parent-toggle-list">
              <label><input type="checkbox" checked={settings.driftReminderEnabled} onChange={(event) => saveSettings({ ...settings, driftReminderEnabled: event.target.checked })} /><span>走神提醒</span></label>
              <label><input type="checkbox" checked={settings.idleReminderEnabled} onChange={(event) => saveSettings({ ...settings, idleReminderEnabled: event.target.checked })} /><span>长时间不学习提醒</span></label>
              <label><input type="checkbox" checked={settings.absentReminderEnabled} onChange={(event) => saveSettings({ ...settings, absentReminderEnabled: event.target.checked })} /><span>离座提醒</span></label>
            </div>
          </section>
        )}

        <section className="parent-control-card">
          <h2>发送提醒</h2>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} />
          <div className="parent-reminder-actions">
            <button disabled={busy} onClick={() => sendReminder("focus", message)}>发送自定义提醒</button>
            <button disabled={busy} onClick={() => sendReminder("focus", "请把注意力拉回当前题目。")}>走神提醒</button>
            <button disabled={busy} onClick={() => sendReminder("idle", "已经有一会儿没有学习动作了，先写下一步。")}>长时间不学习</button>
          </div>
        </section>

        <section className="parent-history-card">
          <h2>最近提醒</h2>
          {(state?.reminders || []).slice(0, 5).map((item) => (
            <div key={item.id}>
              <strong>{item.message}</strong>
              <span>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.delivered ? "已确认" : "待确认"}</span>
            </div>
          ))}
          {!state?.reminders?.length && <p>暂无提醒记录。</p>}
        </section>

        {student?.aiApprovalStatus === "pending" && (
          <div className="modal-backdrop">
            <div className="todo-modal" style={{ textAlign: "center", padding: "30px", maxWidth: "450px" }}>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px", color: "#2563eb" }}>
                <Brain size={48} />
              </div>
              <h2 style={{ margin: "0 0 10px", fontSize: "24px", color: "#13233d" }}>AI 教师使用申请</h2>
              <p style={{ margin: "0 0 16px", fontSize: "15px", color: "#51627b", lineHeight: "1.6" }}>
                孩子申请使用 AI 教师。提问内容如下：
              </p>
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px", marginBottom: "24px", fontSize: "14px", color: "#1e293b", textAlign: "left", wordBreak: "break-all", maxHeight: "120px", overflowY: "auto" }}>
                {student.pendingQuestionText || "暂无提问详情"}
              </div>
              <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
                <button
                  disabled={busy}
                  onClick={() => saveSettings({ ...settings!, aiApprovedQuestionId: student.pendingQuestionId || "", aiApprovalAction: "rejected" })}
                  style={{
                    background: "#ef4444",
                    color: "white",
                    border: 0,
                    borderRadius: "12px",
                    padding: "12px 20px",
                    fontWeight: "bold",
                    fontSize: "16px",
                    cursor: "pointer",
                    flex: 1
                  }}
                >
                  拒绝
                </button>
                <button
                  disabled={busy}
                  onClick={() => saveSettings({ ...settings!, aiApprovedQuestionId: student.pendingQuestionId || "", aiApprovalAction: "approved" })}
                  style={{
                    background: "#22c55e",
                    color: "white",
                    border: 0,
                    borderRadius: "12px",
                    padding: "12px 20px",
                    fontWeight: "bold",
                    fontSize: "16px",
                    cursor: "pointer",
                    flex: 1
                  }}
                >
                  同意使用
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function SettingsPage({
  config,
  onConfig,
  profile,
  onProfile,
  thresholds,
  onThresholds,
  costs,
  speechVoices,
  refreshCosts,
  exportCsv,
  canExportCsv,
  parentConsoleUrl
}: {
  config: AiConfig;
  onConfig: (config: AiConfig) => void;
  profile: TutorProfile;
  onProfile: (profile: TutorProfile) => void;
  thresholds: VisionThresholds;
  onThresholds: (thresholds: VisionThresholds) => void;
  costs: CostSummary;
  speechVoices: SpeechSynthesisVoice[];
  refreshCosts: () => void;
  exportCsv: () => void;
  canExportCsv: boolean;
  parentConsoleUrl: string;
}) {
  return (
    <section className="settings-page">
      <header className="settings-heading">
        <div><span>FOCUSLENS CONTROL CENTER</span><h1>配置中心</h1><p>把监控灵敏度、AI 教师行为和费用边界集中管理。</p></div>
        <div className="settings-heading-actions">
          <button className="ghost" onClick={refreshCosts}><CircleDollarSign size={18} />刷新费用</button>
          <button className="ghost" onClick={exportCsv} disabled={!canExportCsv}><Download size={18} />导出 CSV</button>
        </div>
      </header>

      <section className="settings-cost-strip">
        <div><span>今日调用</span><strong>{costs.todayCalls}</strong><small>次 AI 请求</small></div>
        <div><span>今日估算</span><strong>${costs.todayEstimatedUsd.toFixed(3)}</strong><small>今日累计费用</small></div>
        <div><span>本周估算</span><strong>${costs.weekEstimatedUsd.toFixed(3)}</strong><small>近七日累计费用</small></div>
      </section>

      <ParentConsoleAccessCard baseUrl={config.baseUrl} parentConsoleUrl={parentConsoleUrl} />

      <section className="settings-grid">
        <Panel title="眼神与头部追踪参数" icon={<Eye size={18} />} className="settings-threshold-panel">
          <p className="settings-panel-intro">调整本地判断灵敏度。数值越低，系统越容易触发对应状态。</p>
          <div className="settings-threshold-grid">
            <ThresholdSlider label="抬头判罚阈值" value={thresholds.up} min={0} max={0.5} step={0.01} onChange={(up) => onThresholds({ ...thresholds, up })} />
            <ThresholdSlider label="低头阅读阈值" value={thresholds.down} min={0.2} max={0.8} step={0.01} onChange={(down) => onThresholds({ ...thresholds, down })} />
            <ThresholdSlider label="偏头判罚阈值" value={thresholds.yaw} min={0.1} max={0.5} step={0.01} onChange={(yaw) => onThresholds({ ...thresholds, yaw })} />
            <ThresholdSlider label="斜视判定阈值" value={thresholds.gaze} min={0.05} max={0.4} step={0.01} onChange={(gaze) => onThresholds({ ...thresholds, gaze })} />
          </div>
        </Panel>

        <Panel title="AI 教师与预算" icon={<Settings size={18} />} className="settings-ai-panel">
          <p className="settings-panel-intro">配置本地代理、第三方模型、讲解方式、语音和预算限制。密钥只交给本地后端。</p>
          <ConfigForm config={config} onConfig={onConfig} profile={profile} onProfile={onProfile} speechVoices={speechVoices} />
        </Panel>
      </section>
    </section>
  );
}

function ParentConsoleAccessCard({ baseUrl, parentConsoleUrl }: { baseUrl: string; parentConsoleUrl: string }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [manualLanIp, setManualLanIp] = useState(() => window.localStorage.getItem("focuslens_parent_manual_lan_ip") || "");
  const [lanRefreshNonce, setLanRefreshNonce] = useState(0);
  const [lanStatus, setLanStatus] = useState("正在检测局域网入口...");
  const isLoopbackUrl = useMemo(() => {
    try {
      const hostname = new URL(parentConsoleUrl).hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  }, [parentConsoleUrl]);
  const manualHost = manualLanIp.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const manualParentUrl = manualHost ? `http://${manualHost}:5173/?parent=1` : "";
  const effectiveParentUrl = lanUrls[0] || manualParentUrl || parentConsoleUrl;
  const qrIsLoopback = useMemo(() => {
    try {
      const hostname = new URL(effectiveParentUrl).hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  }, [effectiveParentUrl]);

  useEffect(() => {
    let cancelled = false;
    setLanStatus("正在检测局域网入口...");
    fetchLanAccessInfo(baseUrl, window.location.port || "5173")
      .then((info) => {
        if (cancelled) return;
        const urls = info.frontendUrls || [];
        setLanUrls(urls);
        setLanStatus(urls.length ? `已检测到 ${urls.length} 个局域网入口` : "未检测到局域网 IP，请手动替换为电脑 IP");
      })
      .catch((err) => {
        if (cancelled) return;
        setLanUrls([]);
        setLanStatus(err instanceof Error ? err.message : "局域网入口检测失败");
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, lanRefreshNonce]);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl("");
    if (qrIsLoopback) return;
    QRCode.toDataURL(effectiveParentUrl, {
      width: 196,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#10213f",
        light: "#ffffff"
      }
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveParentUrl, qrIsLoopback]);

  function updateManualLanIp(value: string) {
    setManualLanIp(value);
    if (value.trim()) {
      window.localStorage.setItem("focuslens_parent_manual_lan_ip", value.trim());
    } else {
      window.localStorage.removeItem("focuslens_parent_manual_lan_ip");
    }
  }

  return (
    <section className="parent-lan-card">
      <div className="parent-lan-copy">
        <strong>家长手机端 MVP</strong>
        <span>同一局域网内，手机扫码即可打开家长端，查看学习状态、发送提醒，并开关 AI 教师。</span>
        <code title={effectiveParentUrl}>{effectiveParentUrl}</code>
        {lanUrls.length > 1 ? (
          <select className="parent-lan-select" value={effectiveParentUrl} onChange={(event) => setLanUrls([event.target.value, ...lanUrls.filter((url) => url !== event.target.value)])}>
            {lanUrls.map((url) => <option key={url} value={url}>{url}</option>)}
          </select>
        ) : null}
        <label className="parent-lan-manual">
          电脑局域网 IP
          <input
            value={manualLanIp}
            onChange={(event) => updateManualLanIp(event.target.value)}
            placeholder="例如 192.168.2.9"
          />
        </label>
        {qrIsLoopback ? (
          <small className="parent-lan-warning">
            当前入口是本机地址，手机扫码通常打不开。请用电脑局域网 IP 访问 FocusLens 后再扫码，例如 http://电脑IP:5173/?parent=1。
          </small>
        ) : (
          <small>二维码已使用局域网入口。请确保手机和电脑在同一局域网内，并且防火墙允许 5173 与 8012 端口访问。</small>
        )}
        <small>{lanStatus}{isLoopbackUrl && lanUrls.length ? "，已自动避开 127.0.0.1。" : ""}</small>
        <div className="parent-lan-actions">
          <button className="ghost" onClick={() => setLanRefreshNonce((value) => value + 1)}>自动检测</button>
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(effectiveParentUrl)}>复制入口</button>
          <button className="ghost" onClick={() => window.open(effectiveParentUrl, "_blank", "noopener,noreferrer")}>本机打开</button>
        </div>
      </div>
      <div className="parent-qr-panel" aria-label="家长端二维码">
        {qrDataUrl ? <img src={qrDataUrl} alt="扫码打开家长手机端" /> : <span>{qrIsLoopback ? "请先填写电脑局域网 IP" : "二维码生成中..."}</span>}
        <small>手机扫码打开</small>
      </div>
    </section>
  );
}

type WikiSubTab = "graph" | "browser" | "organize" | "flashcards" | "prompts";

type WikiPromptMap = Record<WikiActionRequest["action"], string>;

const wikiPromptStorageKey = "focuslens_v2_wiki_prompts";
const defaultWikiPrompts: WikiPromptMap = {
  lint: "读取当前 Wiki 和错题证据，合并重复知识点，补全章节，建立知识点/错题/错因/前置知识双链，并列出需要家长确认的无法归类项。只返回可执行 Markdown。",
  query: "读取当前 Wiki 内容，围绕薄弱知识点生成练习题。每题包含题目、考查点、答案、分步解析、与原错题的关系。数学公式使用 LaTeX。",
  flashcards: "读取当前 Wiki 内容，生成正反面闪卡。正面是可回忆的问题或小题，背面包含准确答案、关键步骤、常见错因和一个微练习。不要把掌握度统计当作答案。",
  report: "读取当前 Wiki 图谱和错题证据，生成家长可读阶段报告：学习概况、薄弱摘要、重复错因、前置缺口、复习顺序、近期错题证据。"
};

function loadWikiPrompts(): WikiPromptMap {
  try {
    const raw = window.localStorage.getItem(wikiPromptStorageKey);
    return raw ? { ...defaultWikiPrompts, ...JSON.parse(raw) } : defaultWikiPrompts;
  } catch {
    return defaultWikiPrompts;
  }
}

function saveWikiPrompts(value: WikiPromptMap) {
  window.localStorage.setItem(wikiPromptStorageKey, JSON.stringify(value));
}

function buildParentConsoleUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("parent", "1");
  return url.toString();
}

function cleanTitle(title: string): string {
  if (!title) return "";
  let clean = title.trim();
  // Remove common question prefixes/labels
  clean = clean.replace(/^(Q[:：\-\s]|问题[:：\-\s]|【错题】|错题[:：\-\s]|Question[:：\-\s])/gi, "").trim();
  clean = clean.replace(/^(为什么|如何|怎么|什么是|请问|求下列|求下述|求|分析)/g, "").trim();
  clean = clean.replace(/^[·•\-–—:：\s]+/, "").trim();
  // Remove trailing question marks/punctuation
  clean = clean.replace(/[\?？!！\.:：]+$/, "").trim();
  return clean || title;
}

function wikiTreeLeafTitle(page: WikiPageSummary): string {
  if (page.type !== "mistake") return cleanTitle(page.title);
  const match = page.path.match(/(\d{4})(\d{2})(\d{2})_/);
  return match ? `错题记录 · ${Number(match[2])}月${Number(match[3])}日` : "错题记录";
}

interface TreeNode {
  id: string;
  title: string;
  type: WikiPageSummary["type"] | "folder";
  page?: WikiPageSummary;
  children: TreeNode[];
}

function buildHierarchy(pages: WikiPageSummary[]): TreeNode[] {
  const rootNodes: TreeNode[] = [];

  // Find index/subject pages (e.g. general info)
  const indexPages = pages.filter(p => p.type === "index" || p.type === "subject");
  for (const page of indexPages) {
    rootNodes.push({
      id: page.id,
      title: page.title,
      type: page.type,
      page,
      children: []
    });
  }

  // Find AI runs & reports
  const runsAndReports = pages.filter(p => ["lint", "query", "flashcards", "report"].includes(p.type));

  // The rest are chapter, knowledge, mistake, or normal page
  const contentPages = pages.filter(p => !["index", "subject", "lint", "query", "flashcards", "report"].includes(p.type));

  // Group by chapter name
  const chapterGroups = new Map<string, WikiPageSummary[]>();
  const chapterPages = new Map<string, WikiPageSummary>();

  for (const page of contentPages) {
    if (page.type === "chapter") {
      chapterPages.set(page.chapter?.trim() || page.title, page);
    } else {
      const chapName = page.chapter ? page.chapter.trim() : "未分类章节";
      if (!chapterGroups.has(chapName)) {
        chapterGroups.set(chapName, []);
      }
      chapterGroups.get(chapName)!.push(page);
    }
  }

  // Build chapter tree nodes
  const chapterNodes: TreeNode[] = [];
  for (const [chapName, items] of chapterGroups.entries()) {
    const chapPage = chapterPages.get(chapName);
    const kpGroups = new Map<string, WikiPageSummary[]>();
    const kpPages = new Map<string, WikiPageSummary>();
    const chapLevelItems: WikiPageSummary[] = [];

    for (const item of items) {
      if (item.type === "knowledge") {
        kpPages.set(item.knowledgePoint || item.title, item);
      } else if (item.knowledgePoint) {
        const kpName = item.knowledgePoint.trim();
        if (!kpGroups.has(kpName)) {
          kpGroups.set(kpName, []);
        }
        kpGroups.get(kpName)!.push(item);
      } else {
        chapLevelItems.push(item);
      }
    }

    const kpNodes: TreeNode[] = [];
    for (const [kpName, kpItems] of kpGroups.entries()) {
      const kpPage = kpPages.get(kpName);
      const leafNodes: TreeNode[] = kpItems.map(item => ({
        id: item.id,
        title: item.title,
        type: item.type,
        page: item,
        children: []
      }));

      kpNodes.push({
        id: kpPage?.id || `kp-virtual-${chapName}-${kpName}`,
        title: kpName,
        type: kpPage ? "knowledge" : "folder",
        page: kpPage,
        children: leafNodes
      });
    }

    // Sort knowledge points
    kpNodes.sort((a, b) => a.title.localeCompare(b.title));

    // Add remaining chapter level items as leaves
    const chapLeafNodes: TreeNode[] = chapLevelItems.map(item => ({
      id: item.id,
      title: item.title,
      type: item.type,
      page: item,
      children: []
    }));

    chapterNodes.push({
      id: chapPage?.id || `chapter-virtual-${chapName}`,
      title: chapName,
      type: chapPage ? "chapter" : "folder",
      page: chapPage,
      children: [...kpNodes, ...chapLeafNodes]
    });
  }

  // Sort chapters
  chapterNodes.sort((a, b) => a.title.localeCompare(b.title));
  rootNodes.push(...chapterNodes);

  // If there are runs and reports, add them under a virtual folder
  if (runsAndReports.length > 0) {
    rootNodes.push({
      id: "virtual-runs",
      title: "AI 整理与报告",
      type: "folder",
      children: runsAndReports.map(p => ({
        id: p.id,
        title: p.title,
        type: p.type,
        page: p,
        children: []
      }))
    });
  }

  return rootNodes;
}

function WikiPageView({
  pages,
  graph,
  selectedPage,
  searchQuery,
  busy,
  actionResult,
  flashcards,
  onOpenPage,
  onRebuild,
  onReclassify,
  onStatusChange,
  onRunAction
}: {
  pages: WikiPageSummary[];
  graph: WikiGraphResponse | null;
  selectedPage: WikiPage | null;
  searchQuery: string;
  busy: string;
  actionResult: string;
  flashcards: FlashcardItem[];
  onOpenPage: (pageId: string) => void;
  onRebuild: () => void;
  onReclassify: (pageId: string, subject: string, chapter: string) => void;
  onStatusChange: (pageId: string, status: "weak" | "learning" | "mastered" | "ignored") => void;
  onRunAction: (request: Omit<WikiActionRequest, "config" | "profile">) => void;
}) {
  const subjects = Array.from(new Set([...(graph?.nodes.map((node) => node.subject).filter(Boolean) ?? []), ...pages.map((page) => page.subject).filter(Boolean)].map(normalizeSubject)))
    .sort((a, b) => {
      const preferred = ["数学", "英语", "语文"];
      const aIndex = preferred.indexOf(normalizeSubject(a));
      const bIndex = preferred.indexOf(normalizeSubject(b));
      return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex) || a.localeCompare(b);
    });
  const knowledgeOptions = Array.from(new Set(pages.map((page) => page.knowledgePoint || (page.type === "knowledge" ? page.title : "")).filter(Boolean))).slice(0, 80);
  const [activeWikiTab, setActiveWikiTab] = useState<WikiSubTab>("graph");
  const [subject, setSubject] = useState("");
  const [knowledgePoint, setKnowledgePoint] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [difficulty, setDifficulty] = useState("基础");
  const [count, setCount] = useState(5);
  const [graphMode, setGraphMode] = useState<"all" | "hot" | "prerequisite" | "reason">("all");
  const [selectedGraphNode, setSelectedGraphNode] = useState<WikiGraphNode | null>(null);
  const [promptAction, setPromptAction] = useState<WikiActionRequest["action"]>("lint");
  const [promptTemplates, setPromptTemplates] = useState<WikiPromptMap>(loadWikiPrompts);
  const [manualSubject, setManualSubject] = useState("");
  const [manualChapter, setManualChapter] = useState("");
  const query = searchQuery.trim().toLowerCase();
  const filteredPages = pages.filter((page) =>
    (!query || `${page.title} ${page.subject} ${page.knowledgePoint} ${page.type}`.toLowerCase().includes(query)) &&
    (!subject || normalizeSubject(page.subject) === normalizeSubject(subject) || page.title.includes(subject))
  );
  const coverage = graph?.summary.subjectCoverage ?? [];
  const scopedTopWeakNodes = (graph?.summary.topWeakNodes ?? []).filter((node) =>
    node.type === "knowledge" && (!subject || normalizeSubject(node.subject) === normalizeSubject(subject))
  );
  const scopedPrerequisiteGaps = (graph?.summary.prerequisiteGaps ?? []).filter((node) =>
    !subject || normalizeSubject(node.subject) === normalizeSubject(subject)
  );
  const scopedRepeatedReasons = (graph?.summary.repeatedReasons ?? []).filter((node) =>
    !subject || normalizeSubject(node.subject) === normalizeSubject(subject)
  );
  useEffect(() => {
    if (!subject && subjects.length > 0) {
      const math = subjects.find((item) => normalizeSubject(item) === "数学");
      setSubject(math || subjects[0]);
    }
  }, [subject, subjects.join("|")]);
  useEffect(() => {
    setManualSubject(selectedPage?.subject || "");
    setManualChapter(selectedPage?.type === "chapter" ? selectedPage.title : "");
  }, [selectedPage?.id]);
  const updatePrompt = (action: WikiActionRequest["action"], value: string) => {
    const next = { ...promptTemplates, [action]: value };
    setPromptTemplates(next);
    saveWikiPrompts(next);
  };
  const run = (action: WikiActionRequest["action"]) => onRunAction({ action, subject, knowledgePoint, dateRange, difficulty, count, promptTemplate: promptTemplates[action] });
  return (
    <section className="wiki-workspace wiki-redesign">
      <div className="section-heading wiki-heading wiki-heading-compact">
        <div>
          <h2>本地 Wiki</h2>
          <p>把错题沉淀成 Markdown、双链、图谱和可复习材料。</p>
        </div>
        <div className="wiki-heading-actions">
          <button className="ghost" type="button" onClick={() => setActiveWikiTab("organize")}>AI 整理</button>
          <button type="button" onClick={onRebuild} disabled={!!busy}>{busy === "rebuild" ? "重建中" : "重建索引"}</button>
        </div>
      </div>

      <div className="wiki-subject-overview" aria-label="选择全局学科">
        {subjects.map((item) => {
          const itemCoverage = coverage.find((entry) => normalizeSubject(entry.subject) === normalizeSubject(item));
          const active = normalizeSubject(subject) === normalizeSubject(item);
          return (
            <button key={item} type="button" className={active ? "active" : ""} onClick={() => setSubject(item)}>
              <span>{item}</span>
              <strong>{itemCoverage?.mistakeCount ?? 0}<small>条记录</small></strong>
              <i style={{ width: `${Math.max(8, Math.min(100, itemCoverage?.avgMastery ?? 0))}%` }} />
            </button>
          );
        })}
      </div>

      <div className="wiki-subtabs" role="tablist" aria-label="Wiki sections">
        {[
          ["graph", "薄弱图谱"],
          ["browser", "页面浏览"],
          ["organize", "AI 整理"],
          ["flashcards", "闪卡复习"],
          ["prompts", "提示词"]
        ].map(([id, label]) => (
          <button key={id} type="button" className={activeWikiTab === id ? "active" : ""} onClick={() => setActiveWikiTab(id as WikiSubTab)}>{label}</button>
        ))}
      </div>

      {activeWikiTab === "graph" && (
        <section className="wiki-tab-layout graph-tab">
          <Panel title="薄弱知识图谱" icon={<Brain size={19} />} className="wiki-graph-panel wiki-graph-full">
            <div className="wiki-graph-filterbar">
              <div className="wiki-segmented" aria-label="图谱时间范围">
                {[["all", "全部时间"], ["30d", "近 30 天"], ["7d", "近 7 天"]].map(([value, label]) => (
                  <button type="button" key={value} className={dateRange === value ? "active" : ""} onClick={() => setDateRange(value)}>{label}</button>
                ))}
              </div>
              <select value={graphMode} onChange={(event) => setGraphMode(event.target.value as typeof graphMode)}>
                <option value="all">知识结构</option>
                <option value="hot">高频薄弱点</option>
                <option value="prerequisite">前置缺口</option>
                <option value="reason">错因</option>
              </select>
            </div>
            <KnowledgeGraph graph={graph} subject={subject} dateRange={dateRange} mode={graphMode} selectedId={selectedGraphNode?.id ?? ""} onSelect={setSelectedGraphNode} onOpenPage={onOpenPage} />
            <div className="graph-legend">
              {[
                ["#2563eb", "学科"], ["#7c3aed", "章节"], ["#f59e0b", "知识点"], ["#14b8a6", "前置知识"],
                ...(graphMode === "reason" ? [["#f97316", "错因"]] : [])
              ].map(([color, label]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
              <span className="edge-solid">包含 / 相关</span><span className="edge-dashed">推断关系</span>
            </div>
          </Panel>
          <Panel title="图谱洞察" icon={<AlertCircle size={19} />} className="wiki-insight-panel">
            {selectedGraphNode ? (
              <div className="graph-node-detail">
                <span className="eyebrow">{wikiGraphTypeLabel(selectedGraphNode.type)}</span>
                <h3>{cleanTitle(selectedGraphNode.label)}</h3>
                <div className="graph-node-metrics">
                  <strong>{selectedGraphNode.mistakeCount}<small>相关错题</small></strong>
                  <strong>{Math.round(selectedGraphNode.avgMastery)}%<small>平均掌握</small></strong>
                  <strong>{Math.round(selectedGraphNode.weaknessScore)}<small>薄弱指数</small></strong>
                </div>
                {selectedGraphNode.pageId ? <button type="button" onClick={() => { onOpenPage(selectedGraphNode.pageId!); setActiveWikiTab("browser"); }}>打开 Wiki 页面</button> : null}
              </div>
            ) : <p className="graph-hint">点击图谱节点，查看错题数量、掌握度和对应 Wiki 页面。</p>}
            <GraphRankList title="知识点优先级" nodes={scopedTopWeakNodes} onOpenPage={onOpenPage} />
            <GraphRankList title="前置缺口" nodes={scopedPrerequisiteGaps} onOpenPage={onOpenPage} />
            {graphMode === "reason" ? <GraphRankList title="重复错因" nodes={scopedRepeatedReasons} onOpenPage={onOpenPage} /> : null}
          </Panel>
        </section>
      )}

      {activeWikiTab === "browser" && (
        <section className="wiki-tab-layout browser-tab">
          <Panel title="学科章节树" icon={<Folder size={19} />} className="wiki-tree-panel">
            <WikiTree pages={filteredPages} selectedPageId={selectedPage?.id ?? ""} onOpenPage={onOpenPage} />
          </Panel>
          <Panel title="Markdown 页面" icon={<BookOpen size={19} />} className="wiki-reader-panel wiki-reader-wide">
            {selectedPage ? (
              <>
                <div className="wiki-page-meta">
                  <strong>{cleanTitle(selectedPage.title)}</strong>
                  <span>{wikiTypeLabel(selectedPage.type)} · {selectedPage.path}</span>
                </div>
                <WikiMarkdown markdown={selectedPage.markdown} pages={pages} onOpenPage={onOpenPage} />
              </>
            ) : (
              <p className="empty">点击图谱节点或左侧页面开始浏览。</p>
            )}
          </Panel>
          <Panel title="页面属性" icon={<Settings size={18} />} className="wiki-inspector-panel">
            {selectedPage?.type === "knowledge" ? (
              <div className="knowledge-status-control">
                <strong>掌握状态</strong>
                <div className="knowledge-status-options">
                  {[
                    ["weak", "薄弱"],
                    ["learning", "学习中"],
                    ["mastered", "已掌握"],
                    ["ignored", "忽略"]
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={selectedPage.status === value ? "active" : ""}
                      disabled={busy === "status"}
                      onClick={() => onStatusChange(selectedPage.id, value as "weak" | "learning" | "mastered" | "ignored")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p>“已掌握”和“忽略”默认不会进入后续出题与闪卡复习。</p>
              </div>
            ) : null}
            <div className="wiki-action-form compact-form">
              <label>学科<input value={manualSubject} onChange={(event) => setManualSubject(event.target.value)} placeholder="例如 数学" /></label>
              <label>章节<input value={manualChapter} onChange={(event) => setManualChapter(event.target.value)} placeholder="例如 数与运算" /></label>
              <button type="button" disabled={!selectedPage || busy === "reclassify"} onClick={() => selectedPage && onReclassify(selectedPage.id, manualSubject, manualChapter)}>保存归类</button>
            </div>
            <p className="muted small">当前先支持错题页手工归类。章节和知识点的批量合并建议交给“AI 整理”生成修改建议后确认。</p>
          </Panel>
        </section>
      )}

      {activeWikiTab === "organize" && (
        <section className="wiki-tab-layout action-tab">
          <WikiActionControls subjects={subjects} knowledgeOptions={knowledgeOptions} subject={subject} setSubject={setSubject} knowledgePoint={knowledgePoint} setKnowledgePoint={setKnowledgePoint} dateRange={dateRange} setDateRange={setDateRange} difficulty={difficulty} setDifficulty={setDifficulty} count={count} setCount={setCount} busy={busy} run={run} primaryActions={["lint", "query", "report"]} />
          <Panel title="AI 运行结果" icon={<HelpCircle size={19} />} className="wiki-reader-panel">
            <div className="wiki-agent-boundary"><strong>受约束整理模式</strong><span>AI 读取证据并生成变更建议；当前不会未经确认直接修改 Wiki。</span></div>
            <WikiRunPipeline busy={busy} hasResult={!!actionResult} />
            {actionResult ? <WikiMarkdown markdown={actionResult} pages={pages} onOpenPage={onOpenPage} /> : <p className="empty">选择范围后运行。Lint 会检查、合并、补完和建立双链；Query 会读取 Wiki 后出题；Report 会生成家长报告。</p>}
          </Panel>
        </section>
      )}

      {activeWikiTab === "flashcards" && (
        <section className="wiki-tab-layout flashcard-tab">
          <WikiActionControls subjects={subjects} knowledgeOptions={knowledgeOptions} subject={subject} setSubject={setSubject} knowledgePoint={knowledgePoint} setKnowledgePoint={setKnowledgePoint} dateRange={dateRange} setDateRange={setDateRange} difficulty={difficulty} setDifficulty={setDifficulty} count={count} setCount={setCount} busy={busy} run={run} primaryActions={["flashcards"]} />
          <Panel title="闪卡复习" icon={<Award size={19} />} className="flashcard-stage-panel">
            {flashcards.length > 0 ? <FlashcardDeck cards={flashcards} /> : <p className="empty">点击“一键闪卡”后，会基于薄弱知识点生成可翻面的正反卡。</p>}
          </Panel>
        </section>
      )}

      {activeWikiTab === "prompts" && (
        <section className="wiki-tab-layout prompt-tab">
          <Panel title="默认提示词" icon={<Settings size={19} />} className="wiki-prompt-panel">
            {(Object.keys(defaultWikiPrompts) as WikiActionRequest["action"][]).map((action) => (
              <button type="button" className={`prompt-template-card ${promptAction === action ? "active" : ""}`} key={action} onClick={() => setPromptAction(action)}>
                <span>{wikiActionLabel(action)}</span>
                <small>{wikiPromptDescription(action)}</small>
              </button>
            ))}
          </Panel>
          <Panel title="模板编辑与预览" icon={<BookOpen size={19} />} className="prompt-workbench">
            <div className="prompt-variable-row">
              {wikiPromptVariables(promptAction).map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}
            </div>
            <textarea value={promptTemplates[promptAction]} onChange={(event) => updatePrompt(promptAction, event.target.value)} />
            <div className="button-row">
              <button type="button" className="ghost" onClick={() => updatePrompt(promptAction, defaultWikiPrompts[promptAction])}>恢复默认</button>
              <button type="button" onClick={() => run(promptAction)}>测试运行</button>
            </div>
            <div className="prompt-preview">
              <WikiMarkdown markdown={`## 实时预览\n\n${promptTemplates[promptAction]}\n\n---\n\n**当前变量**：学科 ${subject || "全部"} · 知识点 ${knowledgePoint || "自动选择"} · 数量 ${count}`} pages={pages} onOpenPage={onOpenPage} />
            </div>
          </Panel>
        </section>
      )}
    </section>
  );
}

function WikiActionControls({ subjects, knowledgeOptions, subject, setSubject, knowledgePoint, setKnowledgePoint, dateRange, setDateRange, difficulty, setDifficulty, count, setCount, busy, run, primaryActions }: {
  subjects: string[];
  knowledgeOptions: string[];
  subject: string;
  setSubject: (value: string) => void;
  knowledgePoint: string;
  setKnowledgePoint: (value: string) => void;
  dateRange: string;
  setDateRange: (value: string) => void;
  difficulty: string;
  setDifficulty: (value: string) => void;
  count: number;
  setCount: (value: number) => void;
  busy: string;
  run: (action: WikiActionRequest["action"]) => void;
  primaryActions: WikiActionRequest["action"][];
}) {
  return (
    <Panel title="操作范围" icon={<HelpCircle size={19} />} className="wiki-control-panel">
      <div className="wiki-action-form stacked-form">
        <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}><option value="">自动/全部</option>{subjects.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>知识点<input list="wiki-knowledge-options" value={knowledgePoint} onChange={(event) => setKnowledgePoint(event.target.value)} placeholder="可留空，按薄弱点自动选择" /></label>
        <datalist id="wiki-knowledge-options">{knowledgeOptions.map((item) => <option key={item} value={item} />)}</datalist>
        <label>时间<select value={dateRange} onChange={(event) => setDateRange(event.target.value)}><option value="all">全部</option><option value="30d">近 30 天</option><option value="7d">近 7 天</option></select></label>
        <label>难度<select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option>基础</option><option>中等</option><option>提高</option></select></label>
        <label>数量<input type="number" min={1} max={30} value={count} onChange={(event) => setCount(Number(event.target.value) || 1)} /></label>
      </div>
      <div className="wiki-action-buttons vertical-actions">
        {primaryActions.map((action) => <button key={action} type="button" onClick={() => run(action)} disabled={!!busy}>{busy === action ? "处理中" : wikiActionLabel(action)}</button>)}
      </div>
    </Panel>
  );
}

function WikiTree({ pages, selectedPageId, onOpenPage }: { pages: WikiPageSummary[]; selectedPageId: string; onOpenPage: (pageId: string) => void }) {
  const treeData = useMemo(() => buildHierarchy(pages), [pages]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    initial["virtual-runs"] = false;
    return initial;
  });

  const toggleExpand = (id: string, currentState: boolean) => {
    setExpanded(prev => ({ ...prev, [id]: !currentState }));
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const isLeaf = node.children.length === 0;
    const isExpanded = expanded[node.id] ?? depth === 0;

    if (isLeaf) {
      if (!node.page) return null;
      let icon = <BookOpen size={14} />;
      if (node.type === "mistake") {
        icon = <AlertCircle size={14} className="tree-icon-mistake" />;
      } else if (["lint", "query", "flashcards", "report"].includes(node.type)) {
        icon = <Award size={14} className="tree-icon-run" />;
      }

      return (
        <button
          key={node.id}
          className={`wiki-tree-item depth-${depth} ${selectedPageId === node.id ? "active" : ""}`}
          type="button"
          onClick={() => onOpenPage(node.id)}
        >
          {icon}
          <strong>{wikiTreeLeafTitle(node.page)}</strong>
        </button>
      );
    }

    let folderIcon = <Folder size={15} className="tree-icon-folder" />;
    if (node.type === "chapter") {
      folderIcon = <Folder size={15} className="tree-icon-chapter" />;
    } else if (node.type === "knowledge") {
      folderIcon = <Brain size={15} className="tree-icon-knowledge" />;
    }

    return (
      <div key={node.id} className={`wiki-tree-branch depth-${depth}`}>
        <div className="wiki-tree-branch-header">
          <button
            type="button"
            className="wiki-tree-toggle"
            onClick={() => toggleExpand(node.id, isExpanded)}
            aria-label={isExpanded ? "收起" : "展开"}
          >
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {node.page ? (
            <button
              type="button"
              className={`wiki-tree-branch-link ${selectedPageId === node.page.id ? "active" : ""}`}
              onClick={() => onOpenPage(node.page!.id)}
            >
              {folderIcon}
              <strong>{cleanTitle(node.title)}</strong>
            </button>
          ) : (
            <span className="wiki-tree-branch-label" onClick={() => toggleExpand(node.id, isExpanded)}>
              {folderIcon}
              <strong>{cleanTitle(node.title)}</strong>
            </span>
          )}
        </div>

        {isExpanded && (
          <div className="wiki-tree-branch-children">
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (pages.length === 0) return <p className="empty">暂无 Wiki 页面。完成一次 AI 解题后会生成。</p>;

  return (
    <div className="wiki-tree-scroll hierarchical">
      {treeData.map(node => renderNode(node, 0))}
    </div>
  );
}

function WikiMarkdown({ markdown, pages, onOpenPage }: { markdown: string; pages: WikiPageSummary[]; onOpenPage: (pageId: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const handler = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest("a");
      if (!target) return;
      const href = target.getAttribute("href") || "";
      const text = target.textContent?.trim() || "";
      const cleaned = decodeURIComponent(href.replace(/^wiki:\/\//, "").replace(/^#/, "")).replace(/\.md$/, "");
      const page = pages.find((item) => item.id === cleaned || item.path.endsWith(href) || item.title === text || item.title === cleaned);
      if (page) {
        event.preventDefault();
        onOpenPage(page.id);
      }
    };
    node.addEventListener("click", handler);
    return () => node.removeEventListener("click", handler);
  }, [markdown, pages, onOpenPage]);
  return <div ref={ref} className="markdown wiki-markdown" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(markdown) }} />;
}

function KnowledgeGraph({ graph, subject, dateRange, mode, selectedId, onSelect, onOpenPage }: {
  graph: WikiGraphResponse | null;
  subject: string;
  dateRange: string;
  mode: "all" | "hot" | "prerequisite" | "reason";
  selectedId: string;
  onSelect: (node: WikiGraphNode) => void;
  onOpenPage: (pageId: string) => void;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const nodes = useMemo(() => {
    if (!graph) return [];
    const since = dateRange === "7d" ? Date.now() - 7 * 86400000 : dateRange === "30d" ? Date.now() - 30 * 86400000 : 0;
    const overviewTypes = new Set(["subject", "chapter", "knowledge", "prerequisite"]);
    return graph.nodes.filter((node) => {
      if (subject && normalizeSubject(node.subject) !== normalizeSubject(subject)) return false;
      if (mode === "all" && !overviewTypes.has(node.type)) return false;
      if (mode === "hot" && !node.hot) return false;
      if (mode === "prerequisite" && node.type !== "prerequisite" && node.type !== "knowledge") return false;
      if (mode === "reason" && node.type !== "reason" && node.type !== "knowledge") return false;
      if (since && node.lastSeenAt && new Date(node.lastSeenAt).getTime() < since) return false;
      return true;
    }).slice(0, 64);
  }, [graph, subject, dateRange, mode]);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const edges = (graph?.edges ?? []).filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target)).slice(0, 160);
  const positions = layoutGraphNodes(nodes);
  if (!graph || nodes.length === 0) return <p className="empty">暂无图谱数据。完成 AI 解题后会出现关系图。</p>;
  return (
    <div className="graph-canvas-shell">
      <div className="graph-toolbar">
        <button type="button" onClick={() => setScale((value) => Math.min(2.6, value + 0.15))}>+</button>
        <button type="button" onClick={() => setScale((value) => Math.max(0.55, value - 0.15))}>-</button>
        <button type="button" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>复位</button>
      </div>
      <svg
        className="knowledge-graph dynamic"
        viewBox="0 0 1100 620"
        role="img"
        aria-label="薄弱知识图谱"
        onWheel={(event) => { setScale((value) => Math.min(2.8, Math.max(0.5, value + (event.deltaY < 0 ? 0.08 : -0.08)))); }}
        onPointerDown={(event) => { dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; }}
        onPointerMove={(event) => { if (dragRef.current) setPan({ x: dragRef.current.panX + event.clientX - dragRef.current.x, y: dragRef.current.panY + event.clientY - dragRef.current.y }); }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerLeave={() => { dragRef.current = null; }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}>
          {edges.map((edge) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) return null;
            return <path key={`${edge.source}-${edge.target}-${edge.type}`} d={`M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`} stroke="rgba(82,102,140,.28)" strokeWidth={Math.min(7, 1 + edge.weight)} fill="none" />;
          })}
          {nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const radius = Math.min(40, 12 + node.mistakeCount * 3 + node.weaknessScore / 12);
            const displayLabel = cleanTitle(node.label);
            return (
              <g key={node.id} className={`graph-node ${selectedId === node.id ? "selected" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(node); }} onDoubleClick={() => node.pageId && onOpenPage(node.pageId)} tabIndex={0}>
                <circle cx={pos.x} cy={pos.y} r={radius} fill={graphNodeColor(node)} stroke="white" strokeWidth={selectedId === node.id ? "8" : "5"} />
                <circle cx={pos.x - radius / 3} cy={pos.y - radius / 3} r={Math.max(3, radius / 5)} fill="rgba(255,255,255,.35)" />
                <text x={pos.x} y={pos.y + radius + 18} textAnchor="middle">{displayLabel.length > 11 ? `${displayLabel.slice(0, 11)}…` : displayLabel}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function layoutGraphNodes(nodes: WikiGraphNode[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const center = { x: 540, y: 300 };
  const groups = nodes.reduce<Record<string, WikiGraphNode[]>>((acc, node) => {
    acc[node.type] = [...(acc[node.type] ?? []), node];
    return acc;
  }, {});
  const ring: Record<string, number> = { subject: 0, chapter: 145, knowledge: 245, prerequisite: 315, reason: 360, mistake: 430 };
  Object.entries(groups).forEach(([type, items]) => {
    const radius = ring[type] ?? 260;
    const sorted = items.sort((a, b) => b.weaknessScore - a.weaknessScore);
    sorted.forEach((node, index) => {
      if (type === "subject") {
        positions.set(node.id, center);
      } else {
        const angle = (-Math.PI / 2) + (index / Math.max(sorted.length, 1)) * Math.PI * 2 + (type.length * 0.17);
        positions.set(node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius * 0.68 });
      }
    });
  });
  return positions;
}

function graphNodeColor(node: WikiGraphNode) {
  if (node.type === "subject") return "#2563eb";
  if (node.type === "chapter") return "#7c3aed";
  if (node.type === "knowledge") return node.weaknessScore > 75 ? "#ef4444" : node.weaknessScore > 50 ? "#f59e0b" : "#22c55e";
  if (node.type === "reason") return "#f97316";
  if (node.type === "prerequisite") return "#14b8a6";
  return "#94a3b8";
}

function wikiGraphTypeLabel(type: WikiGraphNode["type"]) {
  return { subject: "学科", chapter: "章节", knowledge: "知识点", mistake: "错题", reason: "重复错因", prerequisite: "前置知识" }[type];
}

function wikiPromptDescription(action: WikiActionRequest["action"]) {
  return {
    lint: "检查重复、补全章节、建立双链并提出变更建议",
    query: "读取薄弱知识与相关错题，生成针对性练习",
    flashcards: "生成可回忆的正反面闪卡与微练习",
    report: "生成家长可读的阶段薄弱分析报告"
  }[action];
}

function wikiPromptVariables(action: WikiActionRequest["action"]) {
  const shared = ["wiki_context", "subject", "date_range"];
  if (action === "lint" || action === "report") return [...shared, "graph_summary"];
  return [...shared, "knowledge", "difficulty", "count"];
}

function WikiRunPipeline({ busy, hasResult }: { busy: string; hasResult: boolean }) {
  const steps = ["读取 Wiki 证据", "识别重复与缺口", "生成双链建议", "输出审核方案"];
  return (
    <div className="wiki-run-pipeline">
      {steps.map((step, index) => {
        const state = hasResult ? "done" : busy ? (index === 0 ? "done" : index === 1 ? "active" : "waiting") : "waiting";
        return <div className={state} key={step}><i>{state === "done" ? "✓" : index + 1}</i><span>{step}</span><small>{state === "done" ? "完成" : state === "active" ? "处理中" : "等待"}</small></div>;
      })}
    </div>
  );
}

function GraphRankList({ title, nodes, onOpenPage }: { title: string; nodes: WikiGraphNode[]; onOpenPage: (pageId: string) => void }) {
  return (
    <div className="graph-rank">
      <h3>{title}</h3>
      {nodes.length === 0 ? <p className="empty compact">暂无</p> : nodes.slice(0, 6).map((node) => (
        <button key={node.id} type="button" onClick={() => node.pageId && onOpenPage(node.pageId)}>
          <span><small>{node.subject || wikiGraphTypeLabel(node.type)}</small>{cleanTitle(node.label)}</span>
          <strong>{node.mistakeCount} 条 · {Math.round(node.avgMastery)}%</strong>
        </button>
      ))}
    </div>
  );
}

function FlashcardDeck({ cards }: { cards: FlashcardItem[] }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [mastered, setMastered] = useState<Set<number>>(new Set());
  const [unclear, setUnclear] = useState<Set<number>>(new Set());
  const card = cards[index];
  if (!card) return null;
  const mark = (kind: "mastered" | "unclear") => {
    if (kind === "mastered") {
      setMastered((current) => new Set(current).add(index));
      setUnclear((current) => { const next = new Set(current); next.delete(index); return next; });
    } else {
      setUnclear((current) => new Set(current).add(index));
      setMastered((current) => { const next = new Set(current); next.delete(index); return next; });
    }
    setIndex((value) => (value + 1) % cards.length);
    setFlipped(false);
  };
  return (
    <div className="flashcard-deck redesigned">
      <div className="flashcard-session-stats">
        <span><strong>{cards.length}</strong>本次卡片</span>
        <span className="good"><strong>{mastered.size}</strong>已掌握</span>
        <span className="warn"><strong>{unclear.size}</strong>还模糊</span>
        <span><strong>{Math.round((mastered.size / cards.length) * 100)}%</strong>掌握率</span>
      </div>
      <div className="flashcard-progress"><i style={{ width: `${((index + 1) / cards.length) * 100}%` }} /></div>
      <div className={`flashcard ${flipped ? "flipped" : ""}`} onClick={() => setFlipped((value) => !value)}>
        <div className="flashcard-face-label">{flipped ? "背面" : "正面"}</div>
        <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(flipped ? card.backMarkdown : card.frontMarkdown) }} />
        <div className="flashcard-source">{card.knowledgePoint || "薄弱知识点"}</div>
      </div>
      <div className="flashcard-actions">
        <button type="button" onClick={() => setFlipped((value) => !value)}>{flipped ? "看正面" : "看背面"}</button>
        <button type="button" onClick={() => { setIndex((value) => (value + 1) % cards.length); setFlipped(false); }}>下一张</button>
        <button type="button" className="ghost success" onClick={() => mark("mastered")}>已掌握</button>
        <button type="button" className="ghost danger" onClick={() => mark("unclear")}>还模糊</button>
        <span>{index + 1}/{cards.length}</span>
      </div>
    </div>
  );
}

function groupWikiPages(pages: WikiPageSummary[]) {
  const grouped = new Map<string, WikiPageSummary[]>();
  for (const page of pages) {
    const subject = page.subject ? normalizeSubject(page.subject) : (page.type === "index" ? "总览" : page.type === "mistake" ? "待归类错题" : "运行记录");
    grouped.set(subject, [...(grouped.get(subject) ?? []), page]);
  }
  return Array.from(grouped.entries()).map(([subject, groupPages]) => ({
    subject,
    pages: groupPages.sort((a, b) => wikiTypeOrder(a.type) - wikiTypeOrder(b.type) || a.title.localeCompare(b.title))
  }));
}

function wikiTypeOrder(type: WikiPageSummary["type"]) {
  return { index: 0, subject: 1, chapter: 2, knowledge: 3, mistake: 4, lint: 5, query: 6, flashcards: 7, report: 8, page: 9 }[type] ?? 9;
}

function wikiTypeLabel(type: WikiPageSummary["type"]) {
  return { index: "总览", subject: "学科", chapter: "章节", knowledge: "知识点", mistake: "错题", lint: "整理", query: "出题", flashcards: "闪卡", report: "报告", page: "页面" }[type] ?? "页面";
}

function wikiActionLabel(action: WikiActionRequest["action"]) {
  return { lint: "生成整理建议", query: "一键出题", flashcards: "一键闪卡", report: "一键报告" }[action];
}

function MaterialsPage({
  baseUrl,
  aiConfig,
  pages,
  terms,
  termId,
  onTermChange,
  onError
}: {
  baseUrl: string;
  aiConfig: { aiBaseUrl: string; apiKey: string; model: string; enableThinking: boolean };
  pages: WikiPageSummaryV2[];
  terms: WikiTerm[];
  termId: string;
  onTermChange: (termId: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <section className="materials-page-shell">
      <header className="materials-page-head">
        <div>
          <span className="eyebrow">Practice from confirmed knowledge</span>
          <h1>学习材料</h1>
          <p>从已经沉淀的 Wiki 知识点生成试卷、记忆闪卡和阶段报告。</p>
        </div>
        <label className="materials-term-picker">
          <span>学习阶段</span>
          <select value={termId} onChange={(event) => onTermChange(event.target.value)}>
            {terms.length === 0 ? <option value="legacy">未分学期</option> : null}
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                {term.label}{term.status === "archived" ? "（已归档）" : ""}
              </option>
            ))}
            <option value="all">全部历史 / 大复习</option>
          </select>
        </label>
      </header>
      <MaterialsView
        baseUrl={baseUrl}
        aiConfig={aiConfig}
        pages={pages}
        termId={termId}
        onError={onError}
      />
    </section>
  );
}

function MistakesPage({
  mistakes,
  wiki,
  wikiInbox,
  searchQuery,
  onDelete,
  onSubjectChange,
  onConfirmInbox,
  onDeleteInbox,
  onRerunInbox,
  onOpenWiki
}: {
  mistakes: MistakeEntry[];
  wiki: KnowledgeWiki[];
  wikiInbox: WikiInboxItem[];
  searchQuery: string;
  onDelete: (id: string) => void;
  onSubjectChange: (entry: MistakeEntry, subject: string) => void;
  onConfirmInbox: (itemId: string) => Promise<void>;
  onDeleteInbox: (itemId: string) => Promise<void>;
  onRerunInbox: (itemId: string, decision: any, lockedFields: string[]) => Promise<any>;
  onOpenWiki: () => void;
}) {
  const query = searchQuery.trim().toLowerCase();
  const visibleMistakes = query
    ? mistakes.filter((entry) => `${entry.subject} ${entry.knowledgePoint} ${entry.mistakeReason} ${entry.questionText ?? ""} ${entry.studentQuestion} ${entry.answerMarkdown}`.toLowerCase().includes(query))
    : mistakes;
  const visibleWiki = query
    ? wiki.filter((item) => `${item.subject} ${item.knowledgePoint} ${item.markdown}`.toLowerCase().includes(query))
    : wiki;
  const [customSubjects, setCustomSubjects] = useState<string[]>(loadCustomSubjects);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [selectedInboxIds, setSelectedInboxIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const pendingBySubject = groupInboxBySubject(wikiInbox);
  const pendingSubjects = Array.from(pendingBySubject.keys());
  const subjectOptions = Array.from(new Set([...buildSubjectOptions(mistakes, wiki, customSubjects), ...pendingSubjects]));
  const folderSubjects = Array.from(new Set([...buildSubjectOptions(visibleMistakes, visibleWiki, customSubjects), ...pendingSubjects]))
    .filter((subject) =>
      customSubjects.includes(subject) ||
      visibleMistakes.some((entry) => normalizeSubject(entry.subject) === subject) ||
      visibleWiki.some((item) => normalizeSubject(item.subject) === subject) ||
      (pendingBySubject.get(subject)?.length ?? 0) > 0
    );
  const grouped = groupMistakesBySubject(visibleMistakes, folderSubjects);
  const [openSubjects, setOpenSubjects] = useState<Record<string, boolean>>({});
  useEffect(() => saveCustomSubjects(customSubjects), [customSubjects]);
  useEffect(() => {
    const validInboxIds = new Set(wikiInbox.map((item) => item.id));
    setSelectedInboxIds((current) => {
      const next = new Set([...current].filter((id) => validInboxIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [wikiInbox]);
  const addSubject = () => {
    const subject = normalizeSubject(newSubjectName.trim());
    if (!subject) return;
    setCustomSubjects((current) => current.includes(subject) ? current : [...current, subject]);
    setNewSubjectName("");
  };
  const toggleInboxSelection = (itemIds: string[], selected: boolean) => {
    setSelectedInboxIds((current) => {
      const next = new Set(current);
      itemIds.forEach((id) => selected ? next.add(id) : next.delete(id));
      return next;
    });
  };
  const batchConfirmSelected = async () => {
    const inboxIds = [...selectedInboxIds];
    if (!inboxIds.length) return;
    setBatchBusy(true);
    try {
      for (const id of inboxIds) {
        await onConfirmInbox(id);
      }
      setSelectedInboxIds(new Set());
    } finally {
      setBatchBusy(false);
    }
  };
  return (
    <section className="mistake-section">
      <div className="section-heading">
        <h2>错题知识点</h2>
        <p>先处理待确认归类和待订正错题；确认沉淀后的知识只在 Wiki 中查询。</p>
      </div>
      <div className="evidence-flow-summary">
        <div><strong>{wikiInbox.length}</strong><span>待确认归类</span></div>
        <div><strong>{visibleMistakes.length}</strong><span>待订正错题</span></div>
        <div><strong>{visibleWiki.length}</strong><span>已沉淀知识</span></div>
      </div>
      <div className="evidence-batch-toolbar">
        <div>
          <strong>批量确认沉淀</strong>
          <span>只处理 AI 不确定的待确认归类；普通错题仍在本页订正，沉淀后到 Wiki 查询。</span>
        </div>
        <button type="button" onClick={batchConfirmSelected} disabled={selectedInboxIds.size === 0 || batchBusy}>
          {batchBusy ? "沉淀中..." : `沉淀选中 ${selectedInboxIds.size} 条`}
        </button>
      </div>
      <div className="subject-manager">
        <div>
          <strong>学科/文件夹</strong>
          <span>AI 识别到新学科会自动出现，也可以在这里手动新增。</span>
        </div>
        <div className="subject-add-row">
          <input
            value={newSubjectName}
            onChange={(event) => setNewSubjectName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") addSubject(); }}
            placeholder="新增分类，例如 物理、化学、外语"
          />
          <button type="button" onClick={addSubject}>新增分类</button>
        </div>
      </div>
      {grouped.length === 0 ? (
        <p className="empty">还没有错题记录。完成一次 AI 求助后会自动生成。</p>
      ) : (
        grouped.map(({ subject, entries }) => (
          <section className="subject-folder" key={subject}>
            <button className="folder-heading" onClick={() => setOpenSubjects((prev) => ({ ...prev, [subject]: !(prev[subject] ?? true) }))}>
              <h3><Folder size={18} />{subject}</h3>
              <span>{pendingBySubject.get(subject)?.length ?? 0} 待确认 · {entries.length} 错题 · {visibleWiki.filter((item) => normalizeSubject(item.subject) === subject).length} 知识 {(openSubjects[subject] ?? true) ? "收起" : "展开"}</span>
            </button>
            {(openSubjects[subject] ?? true) && (
              <div className="evidence-folder-flow">
                {(() => {
                  const pendingItems = pendingBySubject.get(subject) ?? [];
                  const wikiCount = visibleWiki.filter((item) => normalizeSubject(item.subject) === subject).length;
                  return (
                    <>
                      {pendingItems.length > 0 ? (
                        <div className="evidence-stage">
                          <div className="evidence-stage-head">
                            <strong>待确认归类</strong>
                            <label className="check mini-check">
                              <input
                                type="checkbox"
                                checked={pendingItems.every((item) => selectedInboxIds.has(item.id))}
                                onChange={(event) => toggleInboxSelection(pendingItems.map((item) => item.id), event.target.checked)}
                              />
                              全选本组
                            </label>
                          </div>
                          <InboxView
                            inbox={pendingItems}
                            onConfirm={onConfirmInbox}
                            onDelete={onDeleteInbox}
                            onRerun={onRerunInbox}
                            selectedIds={selectedInboxIds}
                            onSelectionChange={(id, selected) => toggleInboxSelection([id], selected)}
                            showBanner={false}
                            emptyText=""
                            className="evidence-inbox-inline"
                          />
                        </div>
                      ) : null}
                      {entries.length > 0 ? (
                        <div className="evidence-stage">
                          <div className="evidence-stage-head"><strong>待订正错题</strong><span>用于复盘错因，也可继续调整学科归类</span></div>
                          <div className="mistake-grid">
                            {entries.map((entry) => (
                              <MistakeCard
                                key={entry.id}
                                entry={entry}
                                subjectOptions={subjectOptions}
                                onDelete={onDelete}
                                onSubjectChange={onSubjectChange}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {wikiCount > 0 ? (
                        <div className="evidence-stage archived-stage">
                          <div className="evidence-stage-head"><strong>已沉淀知识</strong><span>{wikiCount} 个知识点已进入 Wiki，此处不再重复展示。</span></div>
                          <button type="button" className="ghost" onClick={onOpenWiki}><BookOpen size={16} />去 Wiki 查询</button>
                        </div>
                      ) : null}
                      {pendingItems.length === 0 && entries.length === 0 ? (
                        <p className="empty folder-empty">这个分类还没有待处理证据。</p>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            )}
          </section>
        ))
      )}
    </section>
  );
}

function groupMistakesBySubject(mistakes: MistakeEntry[], subjectOptions: string[]) {
  const map = new Map<string, MistakeEntry[]>();
  for (const subject of subjectOptions) {
    map.set(normalizeSubject(subject), []);
  }
  for (const entry of mistakes) {
    const subject = normalizeSubject(entry.subject);
    map.set(subject, [...(map.get(subject) ?? []), entry]);
  }
  return Array.from(map.entries())
    .map(([subject, entries]) => ({ subject, entries }))
    .filter(({ subject, entries }) => entries.length > 0 || subjectOptions.includes(subject));
}

function groupInboxBySubject(inbox: WikiInboxItem[]) {
  const map = new Map<string, WikiInboxItem[]>();
  for (const item of inbox) {
    const subject = normalizeSubject(item.meta.decision.subject || "待确认");
    map.set(subject, [...(map.get(subject) ?? []), item]);
  }
  return map;
}

function buildTutorQuestion(rawQuestion: string, captureImage: boolean, previousAnswer: string) {
  const question = rawQuestion.trim();
  const questionNumber = extractQuestionNumber(question);
  const hints: string[] = [];
  if (questionNumber) {
    hints.push(`【题号提示：孩子明确说的是第 ${questionNumber} 题。请优先定位并解答卷面上的第 ${questionNumber} 题；如果手指位置和题号冲突，以题号为准。】`);
  } else if (captureImage) {
    hints.push("【定位提示：孩子没有明确说题号时，参考手指位置；如果画面里有多个题目，请先说明你定位到的是哪一题。】");
  }
  if (!captureImage && previousAnswer) {
    hints.push("【追问提示：这是同一道题的上下文追问，不要重新要求截图，基于上一轮解答继续回答。】");
  }
  return [...hints, question].filter(Boolean).join("\n");
}

function extractQuestionNumber(text: string) {
  const normalized = normalizeSpeech(text);
  const digitMatch = normalized.match(/第?(\d{1,3})[题題]/);
  if (digitMatch) return digitMatch[1];
  const chineseMatch = normalized.match(/第?([一二三四五六七八九十百两]{1,6})[题題]/);
  if (!chineseMatch) return "";
  const value = chineseNumeralToNumber(chineseMatch[1]);
  return value > 0 ? String(value) : "";
}

function chineseNumeralToNumber(text: string): number {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "十") return 10;
  const hundredIndex = text.indexOf("百");
  if (hundredIndex >= 0) {
    const hundreds = hundredIndex === 0 ? 1 : digits[text[hundredIndex - 1]] || 0;
    return hundreds * 100 + chineseNumeralToNumber(text.slice(hundredIndex + 1));
  }
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text[tenIndex - 1]] || 0;
    const ones = tenIndex === text.length - 1 ? 0 : digits[text[tenIndex + 1]] || 0;
    return tens * 10 + ones;
  }
  return digits[text] || 0;
}

function normalizeSubject(subject: string) {
  const text = (subject || "未分类").trim();
  const lower = text.toLowerCase();
  const mathTerms = ["数学", "分数", "裂项", "相消", "方程", "函数", "几何", "代数", "算式", "计算", "比例", "应用题"];
  const englishTerms = ["英语", "英文", "外语", "phonetics", "vocabulary", "grammar", "english"];
  const chineseTerms = ["语文", "作文", "阅读理解", "古诗", "拼音", "汉字", "chinese"];
  const scienceTerms = ["科学", "物理", "化学", "生物", "science", "physics", "chemistry", "biology"];
  if (mathTerms.some((term) => lower.includes(term.toLowerCase()))) return "数学";
  if (englishTerms.some((term) => lower.includes(term.toLowerCase()))) return "英语";
  if (chineseTerms.some((term) => lower.includes(term.toLowerCase()))) return "语文";
  if (scienceTerms.some((term) => lower.includes(term.toLowerCase()))) return "科学";
  return text;
}

function TabButton({ tab, active, onClick, icon, label }: { tab: AppTab; active: AppTab; onClick: (tab: AppTab) => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      className={active === tab ? "tab active" : "tab"}
      onClick={() => onClick(tab)}
      aria-label={label}
      title={label}
    >
      {icon}
      <span className="tab-label">{label}</span>
    </button>
  );
}

function DeviceSelect({ label, value, devices, onChange }: { label: string; value: string; devices: MediaDeviceInfo[]; onChange: (value: string) => void }) {
  return (
    <label className="device-select">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">自动选择</option>
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}`}</option>
        ))}
      </select>
    </label>
  );
}

function Panel({ title, icon, children, className = "" }: { title: string; icon: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><h2>{icon}{title}</h2>{children}</section>;
}

function Status({ state, reason }: { state: LearningState; reason: string }) {
  return <div className={`status ${state.toLowerCase()}`}><strong>{stateLabel(state)}</strong><span>{reason}</span></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Timeline({ samples }: { samples: SessionSample[] }) {
  const visible = samples.slice(-600);
  return <div className="timeline">{visible.map((sample, index) => <span key={`${sample.ts}-${index}`} className={sample.state.toLowerCase()} title={`${stateLabel(sample.state)} ${sample.reason}`} />)}</div>;
}

function ThresholdSlider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const displayValue = max > 10 ? `${Math.round(value)}%` : value.toFixed(2);
  return (
    <label className="threshold">
      <span>{label}<strong>{displayValue}</strong></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function CaptureRegionControls({ config, onConfig }: { config: AiConfig; onConfig: (config: AiConfig) => void }) {
  const updateCaptureRegion = (patch: Partial<AiConfig["captureRegion"]>) => {
    const next = { ...config.captureRegion, ...patch };
    const x = Math.min(0.9, Math.max(0, next.x));
    const y = Math.min(0.9, Math.max(0, next.y));
    const width = Math.min(1 - x, Math.max(0.1, next.width));
    const height = Math.min(1 - y, Math.max(0.1, next.height));
    onConfig({ ...config, captureRegion: { x, y, width, height } });
  };
  const regionPct = (value: number) => Math.round(value * 100);
  return (
    <div className="capture-region-settings">
      <div className="section-head compact-head">
        <strong>AI 截图框</strong>
        <button type="button" className="ghost" onClick={() => onConfig({ ...config, captureRegion: { x: 0.12, y: 0.18, width: 0.76, height: 0.68 } })}>恢复推荐</button>
      </div>
      <ThresholdSlider label="左边距" value={regionPct(config.captureRegion.x)} min={0} max={80} step={1} onChange={(value) => updateCaptureRegion({ x: value / 100 })} />
      <ThresholdSlider label="上边距" value={regionPct(config.captureRegion.y)} min={0} max={80} step={1} onChange={(value) => updateCaptureRegion({ y: value / 100 })} />
      <ThresholdSlider label="宽度" value={regionPct(config.captureRegion.width)} min={10} max={100} step={1} onChange={(value) => updateCaptureRegion({ width: value / 100 })} />
      <ThresholdSlider label="高度" value={regionPct(config.captureRegion.height)} min={10} max={100} step={1} onChange={(value) => updateCaptureRegion({ height: value / 100 })} />
    </div>
  );
}

function FocusControls({ config, onConfig }: { config: AiConfig; onConfig: (config: AiConfig) => void }) {
  return (
    <div className="capture-region-settings">
      <div className="section-head compact-head">
        <strong>俯拍对焦</strong>
        <div className="segmented mini">
          <button type="button" className={config.paperFocusMode === "auto" ? "active" : ""} onClick={() => onConfig({ ...config, paperFocusMode: "auto" })}>自动</button>
          <button type="button" className={config.paperFocusMode === "manual" ? "active" : ""} onClick={() => onConfig({ ...config, paperFocusMode: "manual" })}>手动</button>
        </div>
      </div>
      <ThresholdSlider label="手动焦距" value={Math.round(config.paperFocusDistance * 100)} min={0} max={100} step={1} onChange={(value) => onConfig({ ...config, paperFocusDistance: value / 100, paperFocusMode: "manual" })} />
      <small className="muted-note">如果画面一直模糊，先切“自动”；若摄像头反复抽动，再切“手动”并慢慢调焦距。</small>
    </div>
  );
}

function VoicePicker({
  value,
  voices,
  onChange,
}: {
  value: string;
  voices: SpeechSynthesisVoice[];
  onChange: (voiceName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedVoice = voices.find((voice) => voice.name === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const chooseVoice = (voiceName: string) => {
    onChange(voiceName);
    setOpen(false);
  };

  return (
    <div className="voice-picker" ref={rootRef}>
      <button
        type="button"
        className="voice-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedVoice ? `${selectedVoice.name} · ${selectedVoice.lang}` : "自动选择中文声音"}</span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div className="voice-picker-menu" role="listbox" aria-label="语音声音">
          <button type="button" role="option" aria-selected={!value} className={!value ? "active" : ""} onClick={() => chooseVoice("")}>
            <strong>自动选择中文声音</strong>
            <small>优先使用自然中文声音</small>
          </button>
          {voices.map((voice) => (
            <button
              type="button"
              role="option"
              aria-selected={voice.name === value}
              className={voice.name === value ? "active" : ""}
              key={`${voice.name}-${voice.lang}`}
              onClick={() => chooseVoice(voice.name)}
              title={`${voice.name} · ${voice.lang}`}
            >
              <strong>{voice.name}</strong>
              <small>{voice.lang}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigForm({ config, onConfig, profile, onProfile, speechVoices }: { config: AiConfig; onConfig: (config: AiConfig) => void; profile: TutorProfile; onProfile: (profile: TutorProfile) => void; speechVoices: SpeechSynthesisVoice[] }) {
  const zhVoices = speechVoices.filter((voice) => voice.lang.toLowerCase().includes("zh"));
  const [aiTestBusy, setAiTestBusy] = useState(false);
  const [aiTestResult, setAiTestResult] = useState("");
  async function runAiConnectionTest() {
    setAiTestBusy(true);
    setAiTestResult("正在测试本地代理和第三方 AI 接口...");
    try {
      const result = await testAiConnection(config);
      setAiTestResult(`${result.ok ? "通过" : "失败"} · HTTP ${result.status || "-"} · ${result.latencyMs}ms\n${result.resolvedUrl}\n${result.message}`);
    } catch (err) {
      setAiTestResult(err instanceof Error ? err.message : "AI 连接测试失败");
    } finally {
      setAiTestBusy(false);
    }
  }
  return (
    <div className="form-stack compact">
      <label>本地后端地址<input value={config.baseUrl} onChange={(e) => onConfig({ ...config, baseUrl: e.target.value })} placeholder="http://127.0.0.1:8012" /></label>
      <label>AI 接口地址<input value={config.aiBaseUrl} onChange={(e) => onConfig({ ...config, aiBaseUrl: e.target.value })} placeholder="留空默认 OpenAI，阿里云常用 https://dashscope.aliyuncs.com/compatible-mode/v1" /></label>
      <label>AI API Key<input type="password" placeholder="用于拍题、追问和 Wiki AI" value={config.apiKey} onChange={(e) => onConfig({ ...config, apiKey: e.target.value })} /></label>
      <label>模型<input value={config.model} onChange={(e) => onConfig({ ...config, model: e.target.value })} placeholder="如 qwen-turbo, gpt-4o-mini" /></label>
      <label>AI 截图范围
        <select value={config.captureMode} onChange={(e) => onConfig({ ...config, captureMode: e.target.value as AiConfig["captureMode"] })}>
          <option value="paper">只截卷面框（快速推荐）</option>
          <option value="full">完整俯拍画面（较慢）</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={config.useStreaming} onChange={(e) => onConfig({ ...config, useStreaming: e.target.checked })} />启用流式首句反馈</label>
      <label className="check"><input type="checkbox" checked={config.enableThinking} onChange={(e) => onConfig({ ...config, enableThinking: e.target.checked })} />启用深度思考（关闭时 prompt 加 /no_think 跳过推理链，响应更快；开启时模型完整推理，答案更准但可能较慢）</label>
      <label className="check"><input type="checkbox" checked={config.allowInsecureAiTls} onChange={(e) => onConfig({ ...config, allowInsecureAiTls: e.target.checked })} />允许自签名 HTTPS 证书（仅用于可信内网/自建 AI 服务）</label>
      <label className="check"><input type="checkbox" checked={config.useBackendAsr} onChange={(e) => onConfig({ ...config, useBackendAsr: e.target.checked })} />语音提问使用专用后端 ASR</label>
      <label>ASR 接口地址<input value={config.asrBaseUrl} onChange={(e) => onConfig({ ...config, asrBaseUrl: e.target.value })} placeholder="需单独支持 /audio/transcriptions；留空自动使用浏览器识别" /></label>
      <label>ASR API Key<input type="password" value={config.asrApiKey} onChange={(e) => onConfig({ ...config, asrApiKey: e.target.value })} placeholder="留空时复用 AI API Key" /></label>
      <label>ASR 模型<input value={config.asrModel} onChange={(e) => onConfig({ ...config, asrModel: e.target.value })} placeholder="whisper-1 或服务商语音识别模型名" /></label>
      <label>语音合成模式
        <select value={config.ttsMode || "edge-tts"} onChange={(e) => onConfig({ ...config, ttsMode: e.target.value as "browser" | "edge-tts" | "cloud" })}>
          <option value="edge-tts">Edge 神经语音（免费，推荐）</option>
          <option value="cloud">云端 API（OpenAI TTS 兼容）</option>
          <option value="browser">浏览器语音（离线，质量差）</option>
        </select>
      </label>
      {(config.ttsMode === "edge-tts" || !config.ttsMode) && (
        <label>Edge TTS 声音<input value={config.edgeTtsVoice || "zh-CN-YunxiNeural"} onChange={(e) => onConfig({ ...config, edgeTtsVoice: e.target.value })} placeholder="zh-CN-YunxiNeural / zh-CN-XiaoxiaoNeural" /></label>
      )}
      <>
        <div className="section-head compact-head"><strong>备用云端 TTS 配置</strong><small>{config.ttsMode === "cloud" ? "当前正在使用" : "切换为云端 API 后使用"}</small></div>
        <label>TTS 接口地址<input value={config.ttsBaseUrl} onChange={(e) => onConfig({ ...config, ttsBaseUrl: e.target.value })} placeholder="留空复用 AI 接口地址，需支持 /audio/speech" /></label>
        <label>TTS API Key<input type="password" value={config.ttsApiKey} onChange={(e) => onConfig({ ...config, ttsApiKey: e.target.value })} placeholder="留空时复用 AI API Key" /></label>
        <label>TTS 模型<input value={config.ttsModel} onChange={(e) => onConfig({ ...config, ttsModel: e.target.value })} placeholder="tts-1 或服务商语音合成模型名" /></label>
        <label>TTS 声音<input value={config.ttsVoice} onChange={(e) => onConfig({ ...config, ttsVoice: e.target.value })} placeholder="alloy / shimmer / 服务商声音名" /></label>
        <label>TTS 语速<input type="number" min={0.5} max={2} step={0.05} value={config.ttsSpeed} onChange={(e) => onConfig({ ...config, ttsSpeed: Number(e.target.value) })} /></label>
        <label>TTS 语言<input value={config.ttsLanguage} onChange={(e) => onConfig({ ...config, ttsLanguage: e.target.value })} placeholder="Chinese；服务不需要时留空" /></label>
        <label>TTS 语气指令<textarea value={config.ttsInstruct} onChange={(e) => onConfig({ ...config, ttsInstruct: e.target.value })} placeholder="例如：用温柔亲切、专业稳重的语气" /></label>
      </>
      <div className="ai-test-box">
        <button type="button" className="ghost" onClick={runAiConnectionTest} disabled={aiTestBusy}>
          {aiTestBusy ? "测试中..." : "测试 AI 连接"}
        </button>
        {aiTestResult && <pre>{aiTestResult}</pre>}
      </div>
      <label>单次预算 USD<input type="number" step="0.01" value={config.singleCallBudgetUsd} onChange={(e) => onConfig({ ...config, singleCallBudgetUsd: Number(e.target.value) })} /></label>
      <label>每日预算 USD<input type="number" step="0.1" value={config.dailyBudgetUsd} onChange={(e) => onConfig({ ...config, dailyBudgetUsd: Number(e.target.value) })} /></label>
      <label className="check"><input type="checkbox" checked={config.allowImageUpload} onChange={(e) => onConfig({ ...config, allowImageUpload: e.target.checked })} />允许上传题目截图</label>
      <label>年级<input value={profile.grade} onChange={(e) => onProfile({ ...profile, grade: e.target.value })} /></label>
      <label>老师名字<input value={profile.teacherName} onChange={(e) => onProfile({ ...profile, teacherName: e.target.value })} /></label>
      <label>学科<input value="AI 自动判断" readOnly /></label>
      <label>讲解风格<input value={profile.style} onChange={(e) => onProfile({ ...profile, style: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={profile.socraticFirst} onChange={(e) => onProfile({ ...profile, socraticFirst: e.target.checked })} />先启发再讲</label>
      <label className="check"><input type="checkbox" checked={profile.allowDirectAnswer} onChange={(e) => onProfile({ ...profile, allowDirectAnswer: e.target.checked })} />允许直接给答案</label>
      <label>语音声音
        <VoicePicker value={profile.speechVoiceName} voices={zhVoices} onChange={(speechVoiceName) => onProfile({ ...profile, speechVoiceName })} />
      </label>
      <label className="threshold">
        <span>语速<strong>{(profile.speechRate || 1.12).toFixed(2)}</strong></span>
        <input type="range" min={0.8} max={1.45} step={0.01} value={profile.speechRate || 1.12} onChange={(e) => onProfile({ ...profile, speechRate: Number(e.target.value) })} />
      </label>
      <label className="threshold">
        <span>音调<strong>{(profile.speechPitch || 1.04).toFixed(2)}</strong></span>
        <input type="range" min={0.8} max={1.3} step={0.01} value={profile.speechPitch || 1.04} onChange={(e) => onProfile({ ...profile, speechPitch: Number(e.target.value) })} />
      </label>
      <div className="device-trigger-box">
        <strong>外设触发</strong>
        <span>当前支持键盘/F8 和蓝牙按键映射成键盘。后续可接 Web Bluetooth / WebHID 专用设备。</span>
        <button type="button" className="ghost" onClick={async () => {
          const nav = navigator as Navigator & { bluetooth?: { requestDevice: (options: unknown) => Promise<unknown> } };
          if (!nav.bluetooth) return alert("当前浏览器不支持 Web Bluetooth。蓝牙按键建议先配对成键盘模式。");
          await nav.bluetooth.requestDevice({ acceptAllDevices: true });
        }}>测试蓝牙设备</button>
      </div>
    </div>
  );
}

function LegacyMistakeCard({ entry }: { entry: MistakeEntry }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Determine accent color theme based on subject
  let subjectClass = "sub-other";
  const sub = entry.subject || "";
  if (sub.includes("英") || sub.includes("english")) {
    subjectClass = "sub-english";
  } else if (sub.includes("数") || sub.includes("math")) {
    subjectClass = "sub-math";
  } else if (sub.includes("语") || sub.includes("文") || sub.includes("chinese")) {
    subjectClass = "sub-chinese";
  } else if (sub.includes("物") || sub.includes("化") || sub.includes("生") || sub.includes("科") || sub.includes("science")) {
    subjectClass = "sub-science";
  }

  // Determine mastery label and class
  let masteryLabel = "需要加强";
  let masteryClass = "m-low";
  if (entry.mastery >= 80) {
    masteryLabel = "基本掌握";
    masteryClass = "m-high";
  } else if (entry.mastery >= 50) {
    masteryLabel = "正在提高";
    masteryClass = "m-medium";
  }

  // Format date if available
  const dateStr = entry.createdAt ? new Date(entry.createdAt).toLocaleDateString("zh-CN") : "";

  return (
    <article className={`mistake-card ${subjectClass}`}>
      <div className="card-header">
        <div className="title-section">
          <BookOpen className="subject-icon" size={16} />
          <strong>{entry.knowledgePoint || "未归类知识点"}</strong>
        </div>
        <span className="subject-badge">{entry.subject} · {entry.grade}</span>
      </div>

      <div className="reason-section">
        <AlertCircle size={15} className="reason-icon" />
        <p>{entry.mistakeReason || "暂无错因分析，需要家长辅导点评。"}</p>
      </div>

      <div className="mastery-section">
        <div className="mastery-info">
          <span className="mastery-title"><Award size={15} />掌握度 {entry.mastery}%</span>
          <span className={`mastery-badge ${masteryClass}`}>{masteryLabel}</span>
        </div>
        <div className="mastery-bar-container">
          <div className={`mastery-bar-fill ${masteryClass}`} style={{ width: `${entry.mastery}%` }} />
        </div>
      </div>

      {dateStr && (
        <div className="card-footer-meta">
          <Calendar size={13} />
          <span>记录于 {dateStr}</span>
        </div>
      )}

      <button className="expand-btn ghost" onClick={() => setIsExpanded(!isExpanded)}>
        {isExpanded ? (
          <>
            <ChevronUp size={16} />
            <span>收起解析</span>
          </>
        ) : (
          <>
            <ChevronDown size={16} />
            <span>查看解析</span>
          </>
        )}
      </button>

      {isExpanded && (
        <div className="expanded-content">
          <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(entry.answerMarkdown) }} />
        </div>
      )}
    </article>
  );
}

function MistakeCard({
  entry,
  subjectOptions,
  onDelete,
  onSubjectChange
}: {
  entry: MistakeEntry;
  subjectOptions: string[];
  onDelete: (id: string) => void;
  onSubjectChange: (entry: MistakeEntry, subject: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const subject = normalizeSubject(entry.subject);
  const mastery = clampMastery(entry.mastery);
  const subjectClass = subjectClassName(subject);
  const masteryClass = mastery >= 80 ? "m-high" : mastery >= 50 ? "m-medium" : "m-low";
  const masteryLabel = mastery >= 80 ? "基本掌握" : mastery >= 50 ? "正在提高" : mastery >= 20 ? "需要加强" : "未掌握";
  const dateStr = entry.createdAt ? new Date(entry.createdAt).toLocaleDateString("zh-CN") : "";

  return (
    <article className={`mistake-card ${subjectClass}`}>
      <div className="card-header">
        <div className="title-section">
          <BookOpen className="subject-icon" size={16} />
          <strong>{entry.knowledgePoint || "未归类知识点"}</strong>
        </div>
        <div className="card-actions">
          <select
            className="subject-select"
            value={subject}
            title="手动调整学科文件夹"
            onChange={(event) => onSubjectChange(entry, event.target.value)}
          >
            {subjectOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <button className="icon-danger" title="删除错题" onClick={() => onDelete(entry.id)}><span aria-hidden="true">×</span><em>删除</em></button>
        </div>
      </div>

      <div className="reason-section">
        <AlertCircle size={15} className="reason-icon" />
        <p>{entry.mistakeReason || "暂无错因分析，需要家长辅导点评。"}</p>
      </div>
      {entry.questionText && (
        <div className="question-text">
          <strong>题干</strong>
          <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(entry.questionText) }} />
        </div>
      )}

      <div className="mastery-section">
        <div className="mastery-info">
          <span className="mastery-title"><Award size={15} />掌握度 {mastery}%</span>
          <span className={`mastery-badge ${masteryClass}`}>{masteryLabel}</span>
        </div>
        <div className="mastery-bar-container">
          <div className={`mastery-bar-fill ${masteryClass}`} style={{ width: `${mastery}%` }} />
        </div>
      </div>

      {dateStr && (
        <div className="card-footer-meta">
          <Calendar size={13} />
          <span>记录于 {dateStr}</span>
        </div>
      )}

      <button className="expand-btn ghost" onClick={() => setIsExpanded(!isExpanded)}>
        {isExpanded ? (
          <>
            <ChevronUp size={16} />
            <span>收起解析</span>
          </>
        ) : (
          <>
            <ChevronDown size={16} />
            <span>查看解析</span>
          </>
        )}
      </button>

      {isExpanded && (
        <div className="expanded-content">
          <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(entry.answerMarkdown) }} />
        </div>
      )}
    </article>
  );
}

function subjectClassName(subject: string) {
  if (subject === "数学") return "sub-math";
  if (subject === "语文") return "sub-chinese";
  if (subject === "英语" || subject === "外语") return "sub-english";
  if (subject === "科学" || subject === "物理" || subject === "化学" || subject === "生物") return "sub-science";
  return "sub-other";
}

function clampMastery(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function chooseDefaultCameras(cams: MediaDeviceInfo[]) {
  const label = (device: MediaDeviceInfo) => device.label.toLowerCase();
  const front = cams.find((device) => /integrated|internal|built.?in|facetime|内置|笔记本/.test(label(device)))
    ?? cams.find((device) => !/usb|ugreen|external|外置|camera 2k/.test(label(device)))
    ?? cams[0];
  const paper = cams.find((device) => device.deviceId !== front?.deviceId && /usb|ugreen|external|外置|camera 2k/.test(label(device)))
    ?? cams.find((device) => device.deviceId !== front?.deviceId)
    ?? cams[1]
    ?? cams[0];
  return { front, paper };
}

function stateLabel(state: LearningState) {
  const labels: Record<LearningState, string> = {
    FOCUSED: "专注",
    READING: "阅读",
    THINKING: "思考",
    WRITING: "书写",
    STALLED: "停滞",
    DISTRACTED: "分心",
    PAUSED: "暂停"
  };
  return labels[state];
}

function normalizeSpeech(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s，。！？,.!?;；:：“”"'`、]/g, "")
    .replace(/这到/g, "这道")
    .replace(/到期/g, "道题")
    .trim();
}

function decodeJsonText(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\r\\n|\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function extractAnswerMarkdown(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string" && parsed !== raw) return extractAnswerMarkdown(parsed);
    if (parsed && typeof parsed === "object") {
      const answer = (parsed as Record<string, unknown>).answer_markdown;
      if (typeof answer === "string" && answer.trim()) return answer.trim();
    }
  } catch {
    // Streaming JSON is often incomplete; extract the answer field below.
  }
  const completeField = raw.match(/"answer_markdown"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:correct_answer_markdown|knowledge_point|mistake_reason|question_text|chapter|prerequisites|mastery|subject)"\s*:/);
  if (completeField?.[1]) return decodeJsonText(completeField[1]).trim();
  const partialField = raw.match(/"answer_markdown"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (partialField?.[1]) return decodeJsonText(partialField[1]).trim();
  return null;
}

function normalizeAiConfig(config: AiConfig): AiConfig {
  if (config.baseUrl.includes(":8000") || config.baseUrl.includes(":8010") || config.baseUrl.includes("localhost:8000") || config.baseUrl.includes("localhost:8010")) {
    return { ...config, baseUrl: "http://127.0.0.1:8012" };
  }
  return config;
}

registerServiceWorker();
createRoot(document.getElementById("root")!).render(<App />);
