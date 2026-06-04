import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  Award,
  BookOpen,
  Brain,
  Calendar,
  Camera,
  Clock,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Download,
  Eye,
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
import { askTutor, askTutorStream, deleteMistakeRemote, fetchMistakes, fetchWiki, getCostSummary, recognizeMemoTodos, testAiConnection, updateMistakeRemote } from "./api";
import { renderMathMarkdown } from "./markdown";
import { cacheMistakes, deleteMistakeLocal, saveAiConfig, loadAiConfig, loadTutorProfile, saveTutorProfile, saveSession, saveMistake, loadMistakes, updateMistake } from "./storage";
import { fuseSignals, summarizeSession } from "./stateMachine";
import type { AiConfig, CostSummary, FrontSignal, KnowledgeWiki, LearningState, MistakeEntry, SessionSample, TutorProfile, WritingSignal } from "./types";
import { createFaceTracker, defaultVisionThresholds, type VisionThresholds } from "./vision";
import { createWritingDetector } from "./writingDetector";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

type AppTab = "dashboard" | "calendar" | "monitor" | "tutor" | "settings" | "mistakes";

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
  { id: "focus", size: "large", visible: true },
  { id: "calendar", size: "medium", visible: true },
  { id: "weakness", size: "medium", visible: true },
  { id: "heatmap", size: "medium", visible: true },
  { id: "weekly", size: "small", visible: true },
  { id: "costs", size: "small", visible: true },
  { id: "timeline", size: "wide", visible: true }
];

type SpeechRecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
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
  const lastReminderAtRef = useRef(0);
  const speechRunIdRef = useRef(0);
  const wakeRecognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const questionRecognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const questionListenTimerRef = useRef(0);
  const wakeActiveRef = useRef(false);
  const captureAskRecognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const captureAskTranscriptRef = useRef("");
  const captureAskFallbackTimerRef = useRef(0);
  const captureAskAutoSubmitRef = useRef(false);
  const thresholdsRef = useRef<VisionThresholds>(defaultVisionThresholds);

  const [tab, setTab] = useState<AppTab>("dashboard");
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
  const [careOffer, setCareOffer] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiConfig>(loadAiConfig);
  const [profile, setProfile] = useState<TutorProfile>(loadTutorProfile);
  const [studentQuestion, setStudentQuestion] = useState("");
  const [recording, setRecording] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [wakeStatus, setWakeStatus] = useState("未开启唤醒");
  const [wakeTranscript, setWakeTranscript] = useState("");
  const [tutorAnswer, setTutorAnswer] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState("");
  const [mistakes, setMistakes] = useState<MistakeEntry[]>(loadMistakes);
  const [wiki, setWiki] = useState<KnowledgeWiki[]>([]);
  const [conversationMode, setConversationMode] = useState(true);
  const [speechStatus, setSpeechStatus] = useState("语音待命");
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [costs, setCosts] = useState<CostSummary>({ todayCalls: 0, todayEstimatedUsd: 0, weekEstimatedUsd: 0, activeAiCalls: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderRecording, setReminderRecording] = useState(false);
  const [customReminderUrl, setCustomReminderUrl] = useState("");
  const [bgMusicUrl, setBgMusicUrl] = useState("");
  const [bgMusicPlaying, setBgMusicPlaying] = useState(false);
  const showSearch = tab === "dashboard" || tab === "mistakes";

  const fused = useMemo(() => fuseSignals(frontSignal, writingSignal, isPaused), [frontSignal, writingSignal, isPaused]);
  const summary = useMemo(() => summarizeSession(samples), [samples]);

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
  }, []);

  useEffect(() => {
    if (!isSessionActive) return;
    const timer = window.setInterval(() => {
      setSamples((prev) => [...prev, { ts: Date.now(), state: fused.state, reason: fused.reason, motionScore: writingSignal.motionScore }]);
      if (fused.shouldOfferCare) setCareOffer(true);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [fused.reason, fused.shouldOfferCare, fused.state, isSessionActive, writingSignal.motionScore]);

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
      if ((event.key === "F8" || event.key === "`") && !event.repeat) {
        event.preventDefault();
        setTab("tutor");
        startCaptureAskListening();
      }
      if (event.key === "F9" && !event.repeat) {
        event.preventDefault();
        setTab("tutor");
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

  async function refreshCostsAndMistakes() {
    try {
      const [remoteCosts, remoteMistakes, remoteWiki] = await Promise.all([getCostSummary(aiConfig.baseUrl), fetchMistakes(aiConfig.baseUrl), fetchWiki(aiConfig.baseUrl)]);
      setCosts(remoteCosts);
      setWiki(remoteWiki);
      if (remoteMistakes.length) {
        setMistakes(remoteMistakes);
        cacheMistakes(remoteMistakes);
      }
    } catch {
      // Local-first mode remains usable when the backend is offline.
    }
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
    if (samples.length > 0) saveSession(samples);
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
    if (aiBusy || captureAskRecognitionRef.current) return;
    setError("");
    setTab("tutor");
    captureAskTranscriptRef.current = "";
    window.clearTimeout(captureAskFallbackTimerRef.current);

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechStatus("浏览器语音识别不可用，已直接截图求助。");
      triggerTutor("manual");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    captureAskAutoSubmitRef.current = false;
    setRecording(true);
    setSpeechStatus("按住 F8 或按钮说题号/疑问，松开后截图求助");
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i <= event.resultIndex; i++) {
        transcript += event.results[i]?.[0]?.transcript || "";
      }
      if (transcript.trim()) {
        captureAskTranscriptRef.current = transcript.trim();
        setWakeTranscript(transcript.trim());
        setStudentQuestion(transcript.trim());
      }
    };
    recognition.onerror = () => {
      captureAskRecognitionRef.current = null;
      setRecording(false);
      triggerTutor("manual", captureAskTranscriptRef.current || undefined);
    };
    recognition.onend = () => {
      const shouldSubmit = captureAskAutoSubmitRef.current || !!captureAskRecognitionRef.current;
      captureAskRecognitionRef.current = null;
      setRecording(false);
      window.clearTimeout(captureAskFallbackTimerRef.current);
      if (shouldSubmit) {
        const transcript = captureAskTranscriptRef.current.trim();
        triggerTutor("manual", transcript || undefined, true);
      }
    };
    captureAskRecognitionRef.current = recognition;
    try {
      recognition.start();
      captureAskFallbackTimerRef.current = window.setTimeout(() => finishCaptureAskListening(), 20000);
    } catch {
      captureAskRecognitionRef.current = null;
      setRecording(false);
      triggerTutor("manual");
    }
  }

  function finishCaptureAskListening() {
    window.clearTimeout(captureAskFallbackTimerRef.current);
    const recognition = captureAskRecognitionRef.current;
    if (!recognition) return;
    captureAskAutoSubmitRef.current = true;
    try {
      recognition.stop();
    } catch {
      captureAskRecognitionRef.current = null;
      setRecording(false);
      triggerTutor("manual", captureAskTranscriptRef.current || undefined, true);
    }
  }

  function finishFollowUpListening() {
    window.clearTimeout(questionListenTimerRef.current);
    const recognition = questionRecognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        questionRecognitionRef.current = null;
        setRecording(false);
      }
    }
    const recorder = audioRecorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  }

  async function startVoiceListening(mode: "new" | "followup") {
    if (recording) {
      finishFollowUpListening();
      return;
    }
    setError("");
    setTab("tutor");
    setSpeechStatus(mode === "followup"
      ? "正在听孩子追问，松开后提交；本次不会重新拍题"
      : "正在听孩子语音提问，松开后提交；本次不会重新拍题"
    );
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      let transcriptText = "";
      recognition.lang = "zh-CN";
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        let transcript = "";
        for (let i = 0; i <= event.resultIndex; i++) {
          transcript += event.results[i]?.[0]?.transcript || "";
        }
        if (transcript.trim()) {
          transcriptText = transcript.trim();
          setStudentQuestion(transcriptText);
          setWakeTranscript(transcriptText);
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "network" || event.error === "aborted" || event.error === "not-allowed" || event.error === "service-not-allowed") {
          setError("语音识别服务不可用（国内网络可能无法访问语音服务器）。请直接按 F8 或点击「截题并求助」。");
        } else {
          setError(`语音识别失败：${event.error}`);
        }
      };
      recognition.onend = () => {
        window.clearTimeout(questionListenTimerRef.current);
        questionRecognitionRef.current = null;
        setRecording(false);
        if (!transcriptText) {
          setSpeechStatus("没有识别到声音，请按住 F9/F10 后再说话");
          return;
        }
        const contextualQuestion = mode === "followup" && tutorAnswer
          ? `【上下文追问】上一轮 AI 教师解答如下，请基于同一道题继续回答孩子的新问题。\n上一轮解答：${tutorAnswer.slice(0, 800)}\n孩子追问：${transcriptText}`
          : transcriptText;
        setSpeechStatus("已收到语音，正在发送给 AI");
        triggerTutor("manual", contextualQuestion, false);
      };
      questionRecognitionRef.current = recognition;
      setRecording(true);
      try {
        recognition.start();
      } catch (err) {
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
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const fallbackQuestion = "孩子通过语音提出了追问。请基于上一轮同一道题继续讲解，不要重新要求截图。";
        setStudentQuestion((current) => current || fallbackQuestion);
        const contextualQuestion = mode === "followup" && tutorAnswer
            ? `【上下文追问】上一轮 AI 教师解答如下，请基于同一道题继续回答孩子的新问题。\n上一轮解答：${tutorAnswer.slice(0, 800)}\n孩子追问：${fallbackQuestion}`
            : fallbackQuestion;
        triggerTutor("manual", contextualQuestion, false);
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

  async function triggerTutor(trigger: "manual" | "care_offer" = "manual", overrideQuestion?: string, captureImage = true) {
    if (aiBusy) return;
    setError("");
    setAiBusy(true);
    setCareOffer(false);
    try {
      const requestConfig = normalizeAiConfig(aiConfig);
      if (requestConfig.baseUrl !== aiConfig.baseUrl) setAiConfig(requestConfig);
      const imageDataUrl = requestConfig.allowImageUpload && captureImage
        ? writingDetectorRef.current?.capturePaperImage(requestConfig.captureMode) ?? null
        : null;
      const rawQuestion = overrideQuestion || studentQuestion || "孩子请求 AI 教师帮助当前题目，请根据孩子手指所在的题目区域引导。";
      const questionAudioText = buildTutorQuestion(rawQuestion, captureImage, tutorAnswer);
      const tutorRequest = {
        questionAudioText,
        imageDataUrl,
        config: requestConfig,
        profile,
        trigger
      };
      let quickSpoken = false;
      let streamedText = "";
      const response = requestConfig.useStreaming
        ? await askTutorStream(tutorRequest, {
            onStatus: (message) => setTutorAnswer(`> ${message}\n\nAI 正在继续解析题目...`),
            onQuick: (text) => {
              quickSpoken = true;
              setTutorAnswer(`> ${text}\n\nAI 正在继续解析题目...`);
            },
            onToken: (token) => {
              streamedText += token;
              // 模型输出的是 JSON 对象，raw token 流包含 JSON 语法外壳
              // 实时截取 answer_markdown 字段内容显示；未进入该字段前显示等待状态
              const mdMatch = streamedText.match(/"answer_markdown"\s*:\s*"((?:[^"\\]|\\.)*)/);
              if (mdMatch) {
                // 去除 JSON 转义，显示已流到的 answer_markdown 内容
                const partial = mdMatch[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
      setTutorAnswer(response.answerMarkdown);
      speakAnswer(response.answerMarkdown, conversationMode);
      setCosts((prev) => ({
        todayCalls: prev.todayCalls + 1,
        todayEstimatedUsd: prev.todayEstimatedUsd + response.estimatedCostUsd,
        weekEstimatedUsd: prev.weekEstimatedUsd + response.estimatedCostUsd,
        activeAiCalls: prev.activeAiCalls + 1
      }));
      saveMistake(response.mistake);
      setMistakes((prev) => [response.mistake, ...prev]);
      await refreshCostsAndMistakes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 教师请求失败");
    } finally {
      setAiBusy(false);
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
    const result = await recognizeMemoTodos({
      imageDataUrl,
      selectedDate,
      config: requestConfig,
      profile
    });
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

  function speakAnswer(markdown: string | any = tutorAnswer, listenAfter = false) {
    if (!("speechSynthesis" in window)) {
      setSpeechStatus("当前浏览器不支持语音朗读");
      return;
    }
    window.speechSynthesis.cancel();

    // 清除控制字符（换页符/退格符等），防止 TTS 中途停止
    let rawText = typeof markdown === "string" ? markdown : tutorAnswer;
    rawText = rawText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    if (!rawText || !rawText.trim()) {
      setSpeechStatus("还没有可朗读的解答");
      return;
    }

    // Auto-close any unclosed math blocks from truncated AI responses
    const doubleDollarCount = (rawText.match(/\$\$/g) || []).length;
    if (doubleDollarCount % 2 !== 0) {
      rawText = rawText + "\n$$";
    }
    const tempText = rawText.replace(/\$\$/g, "");
    const singleDollarCount = (tempText.match(/\$/g) || []).length;
    if (singleDollarCount % 2 !== 0) {
      rawText = rawText + "$";
    }

    // Clean up Markdown and Math notation to make it sound natural when spoken
    // We swap the order: process math before stripping HTML tags so inequalities (<) aren't mistaken for HTML tags.
    // Also convert newlines to Chinese commas to add natural brief pauses in SpeechSynthesis.
    let text = rawText
      .replace(/```[\s\S]*?```/g, " ") // Remove code blocks
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => cleanMathForSpeech(math))
      .replace(/\$([^$]+?)\$/g, (_, math) => cleanMathForSpeech(math))
      .replace(/<[^>]*>/g, " ")        // Remove HTML tags
      .replace(/[#>*_\-\[\]()`]/g, " ") // Remove common markdown symbols
      .replace(/\n+/g, "，")           // Replace newlines with commas for pauses
      .replace(/\s+/g, " ")
      .trim();

    const shortText = summarizeSpeechText(text);
    speakTextChunks(shortText, listenAfter);
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
    const chunks = splitSpeechText(text, 90).slice(0, 4);
    if (!chunks.length) return;
    if (!bestVoice) {
      setSpeechStatus("未找到中文语音。Edge 请安装 Windows 中文语音包，或改用 Chrome/Google 中文语音。");
      return;
    }
    setSpeechStatus(`正在朗读：${bestVoice.name}`);
    const runId = ++speechRunIdRef.current;
    let index = 0;
    const speakNext = () => {
      if (runId !== speechRunIdRef.current) return;
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = "zh-CN";
      utterance.rate = profile.speechRate || 1.12;
      utterance.pitch = profile.speechPitch || 1.04;
      utterance.voice = bestVoice;
      utterance.onerror = () => {
        speechRunIdRef.current += 1;
        setSpeechStatus(`语音朗读失败：${bestVoice.name} 不可用。请换一个声音或安装系统中文语音包。`);
      };
      utterance.onend = () => {
        if (runId !== speechRunIdRef.current) return;
        index += 1;
        if (index < chunks.length) {
          speakNext();
          return;
        }
        setSpeechStatus(listenAfter && conversationMode ? "朗读结束，按住 F9 继续追问，按住 F10 提新问题" : "朗读结束");
      };
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  }

  function summarizeSpeechText(text: string) {
    const important = text
      .split(/[。！？；]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => /先|关键|注意|提示|下一步|因为|所以|应该|需要|错|卡住|已知|要求|关系|公式|方法/.test(part));
    const sentences = text
      .split(/[。！？；]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/题干|知识点|掌握度|错因|```|^\s*[-*#]/.test(part));
    const merged = [...important.slice(0, 3), ...sentences.slice(0, 4)];
    const deduped = merged.filter((part, index) => merged.findIndex((item) => item === part) === index);
    const picked = deduped.slice(0, 5).join("。");
    const base = picked || text.slice(0, 420);
    const clipped = base.length > 520 ? `${base.slice(0, 520)}。` : `${base}。`;
    return text.length > clipped.length + 80
      ? `${clipped}更多细节已经显示在屏幕上，你可以继续问我卡住的那一步。`
      : clipped;
  }

  function splitSpeechText(text: string, maxLen: number) {
    const parts = text.split(/[。！？；]/).map((part) => part.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = "";
    for (const part of parts) {
      if ((current + part).length > maxLen && current) {
        chunks.push(current);
        current = "";
      }
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

  return (
    <main className="app-shell">
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
        <TabButton tab="dashboard" active={tab} onClick={setTab} icon={<LayoutDashboard size={18} />} label="Dashboard" />
        <TabButton tab="calendar" active={tab} onClick={setTab} icon={<Calendar size={18} />} label="学习日历" />
        <TabButton tab="monitor" active={tab} onClick={setTab} icon={<Eye size={18} />} label="监控" />
        <TabButton tab="tutor" active={tab} onClick={setTab} icon={<HelpCircle size={18} />} label="AI 教师" />
        <TabButton tab="settings" active={tab} onClick={setTab} icon={<Settings size={18} />} label="配置" />
        <TabButton tab="mistakes" active={tab} onClick={setTab} icon={<BookOpen size={18} />} label="错题知识点" />
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
          samples={samples}
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
          samples={samples}
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
        />
      </section>

      <section className={tab === "mistakes" ? "tab-page active" : "tab-page"} aria-hidden={tab !== "mistakes"}>
        <MistakesPage mistakes={mistakes} wiki={wiki} searchQuery={searchQuery} onDelete={deleteMistake} onSubjectChange={updateMistakeSubject} />
      </section>
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
  const weakPoints = filteredWiki.slice(0, 4);
  const latestMistakes = filteredMistakes.slice(0, 3);
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
          <div className="mini-label"><Clock size={16} />今日专注</div>
          <strong>{minutes}<span> 分钟</span></strong>
          <p>{fusedReason}</p>
          <div className="soft-progress"><span style={{ width: `${activePercent}%` }} /></div>
          <div className="pill-row">
            <button onClick={onStartVision} disabled={isVisionOn}><Camera size={16} />{isVisionOn ? "摄像头已启动" : "启动摄像头"}</button>
            <button className="ghost" onClick={onStartSession} disabled={isSessionActive}><Play size={16} />{isSessionActive ? "学习中" : "开始学习"}</button>
          </div>
          <div className="quick-card-toolbar">
            <button type="button" onClick={() => setShowQuickCards((value) => !value)}>{showQuickCards ? "隐藏卡片" : "显示卡片"}</button>
            <button type="button" onClick={() => setQuickDensity((value) => value === "compact" ? "comfortable" : "compact")}>{quickDensity === "compact" ? "舒展" : "紧凑"}</button>
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
          <Timeline samples={samples} />
          <div className="latest-list">
            {latestMistakes.length ? latestMistakes.map((entry) => (
              <div key={entry.id}>
                <BookOpen size={16} />
                <span>{entry.knowledgePoint || "未归类知识点"}</span>
                <strong>{normalizeSubject(entry.subject)}</strong>
              </div>
            )) : <p>完成一次 AI 求助后，这里会出现最近错题。</p>}
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
        <aside className="day-detail-panel">
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
          <div className="todo-add-row compact">
            <input value={newTodoText} onChange={(event) => setNewTodoText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTodo(); }} placeholder="新增这一天的任务" />
            <button type="button" onClick={addTodo}>添加</button>
          </div>
          <div className="memo-import-row">
            <button type="button" className="ghost" onClick={importMemo} disabled={memoBusy}><Camera size={16} />{memoBusy ? "识别中" : "拍照识别备忘录"}</button>
            {memoMessage && <small>{memoMessage}</small>}
          </div>
          <div className="calendar-todo-list large">
            {selectedTodos.length === 0 && <p className="todo-empty">这一天还没有任务。</p>}
            {selectedTodos.map((item) => (
              <div className={item.done ? "todo-row compact done" : "todo-row compact"} key={item.id}>
                <button type="button" className="todo-check" aria-label="切换完成状态" onClick={() => toggleTodo(item.id)} />
                <p>{item.text}</p>
                <button type="button" className="todo-delete" aria-label="删除任务" onClick={() => deleteTodo(item.id)}><X size={15} /></button>
              </div>
            ))}
          </div>
        </aside>
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
  return { small: "小", medium: "中", large: "大", wide: "横向" }[size];
}

function loadDashboardLayout(): DashboardCardConfig[] {
  try {
    const raw = localStorage.getItem("focuslens_v2_dashboard_layout");
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
  localStorage.setItem("focuslens_v2_dashboard_layout", JSON.stringify(layout));
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
    <section className="dashboard">
      <Panel title="正面专注追踪" icon={<Camera size={18} />}>
        <video ref={frontVideoRef} className="hidden-video" />
        <canvas ref={frontCanvasRef} width={640} height={480} className="camera-canvas" />
        <Status state={frontSignal.state} reason={frontSignal.reason} />
      </Panel>

      <Panel title="俯拍书写检测" icon={<BookOpen size={18} />}>
        <video ref={paperVideoRef} className="hidden-video" />
        <canvas ref={paperCanvasRef} width={1280} height={720} className="camera-canvas paper" />
        <Status state={writingSignal.active ? "WRITING" : "THINKING"} reason={writingSignal.active ? "检测到卷面局部变化" : "等待书写或阅读思考"} />
        <div className="metric-row">
          <span>书写活跃度</span>
          <strong>{writingSignal.motionScore.toFixed(1)}</strong>
        </div>
        <div className="meter"><span style={{ width: `${Math.min(100, writingSignal.motionScore * 4)}%` }} /></div>
      </Panel>

      <Panel title="俯拍截图与对焦" icon={<Settings size={18} />} className="camera-tools-panel">
        <div className="live-camera-tools">
          <CaptureRegionControls config={aiConfig} onConfig={setAiConfig} />
          <FocusControls config={aiConfig} onConfig={setAiConfig} />
        </div>
      </Panel>

      <Panel title="融合状态机" icon={<Brain size={18} />} className="state-panel">
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
      </Panel>

      <Panel title="声音提醒与背景音乐" icon={<Volume2 size={18} />} className="state-panel">
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
  );
}

function TutorPage({
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
  speakAnswer,
  conversationMode,
  setConversationMode,
  speechStatus
}: {
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
  speakAnswer: (markdown?: string | unknown, listenAfter?: boolean) => void;
  conversationMode: boolean;
  setConversationMode: (value: boolean) => void;
  speechStatus: string;
}) {
  return (
    <section className="single-page">
      <Panel title="AI 教师" icon={<HelpCircle size={18} />} className="wide">
        <div className="tutor-layout">
          <div className="voice-first">
            <div className="quick-ask">
              <button
                className="big-ask"
                onMouseDown={startCaptureAskListening}
                onMouseUp={finishCaptureAskListening}
                onMouseLeave={finishCaptureAskListening}
                onTouchStart={startCaptureAskListening}
                onTouchEnd={finishCaptureAskListening}
                onClick={(event) => event.preventDefault()}
                disabled={aiBusy}
              >
                <Camera size={24} />
                {aiBusy ? "AI 思考中..." : "截题并求助（F8）"}
              </button>
              <span className="quick-hint">点击或按 F8：自动截取俯拍题目 → 发送 AI → 语音播报答案</span>
            </div>
            <div className="wake-card">
              <strong>语音唤醒：喊"{teacherName || "小老师"}"</strong>
              <span>语音唤醒依赖浏览器语音服务，国内网络可能不支持。推荐直接用上方按钮或 F8 键触发。</span>
              <em className={wakeListening ? "wake-live" : ""}>{wakeStatus}</em>
            </div>
            <div className="transcript-box">
              <span>最近识别</span>
              <strong>{wakeTranscript || studentQuestion || "等待语音提问或点击上方按钮直接求助。"}</strong>
            </div>
            <div className="button-row">
              <button onClick={startWakeListening}>{wakeListening ? <Square size={18} /> : <Mic size={18} />}{wakeListening ? "停止唤醒" : "开启唤醒"}</button>
              <button
                onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); recordQuestion(); }}
                onPointerUp={finishFollowUpListening}
                onPointerCancel={finishFollowUpListening}
                onPointerLeave={finishFollowUpListening}
                onClick={(event) => event.preventDefault()}
                disabled={aiBusy}
              >
                {recording ? <Square size={18} /> : <Mic size={18} />}{recording ? "松开结束" : "按住语音提问（F10）"}
              </button>
              <button
                className="ghost"
                onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); followUpQuestion(); }}
                onPointerUp={finishFollowUpListening}
                onPointerCancel={finishFollowUpListening}
                onPointerLeave={finishFollowUpListening}
                onClick={(event) => event.preventDefault()}
                disabled={!tutorAnswer || aiBusy}
              >
                {recording ? <Square size={18} /> : <Mic size={18} />}按住追问（F9）
              </button>
              <button className="ghost" onClick={speakAnswer} disabled={!tutorAnswer}><Volume2 size={18} />朗读解答</button>
              <button className="ghost" onClick={() => speakAnswer("语音测试。我是小老师，现在可以听到我的声音吗？")}><Volume2 size={18} />测试语音</button>
            </div>
            <div className="speech-status">{speechStatus}</div>
            <label className="check">
              <input type="checkbox" checked={conversationMode} onChange={(event) => setConversationMode(event.target.checked)} />
              AI 讲完后继续听孩子追问
            </label>
          </div>
          <div className="answer-box" dangerouslySetInnerHTML={{ __html: tutorAnswer ? renderMathMarkdown(tutorAnswer) : "<p>AI 解答会显示在这里，但默认会同步语音朗读。数学公式支持 $x^2$ 和 $$a^2+b^2=c^2$$。</p>" }} />
        </div>
      </Panel>
    </section>
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
  canExportCsv
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
}) {
  return (
    <section className="settings-grid">
      <Panel title="眼神与头部追踪参数" icon={<Eye size={18} />}>
        <ThresholdSlider label="抬头判罚阈值" value={thresholds.up} min={0} max={0.5} step={0.01} onChange={(up) => onThresholds({ ...thresholds, up })} />
        <ThresholdSlider label="低头阅读阈值" value={thresholds.down} min={0.2} max={0.8} step={0.01} onChange={(down) => onThresholds({ ...thresholds, down })} />
        <ThresholdSlider label="偏头判罚阈值" value={thresholds.yaw} min={0.1} max={0.5} step={0.01} onChange={(yaw) => onThresholds({ ...thresholds, yaw })} />
        <ThresholdSlider label="斜视判定阈值" value={thresholds.gaze} min={0.05} max={0.4} step={0.01} onChange={(gaze) => onThresholds({ ...thresholds, gaze })} />
      </Panel>

      <Panel title="AI 与预算配置" icon={<Settings size={18} />}>
        <ConfigForm config={config} onConfig={onConfig} profile={profile} onProfile={onProfile} speechVoices={speechVoices} />
      </Panel>

      <Panel title="费用概览" icon={<CircleDollarSign size={18} />}>
        <div className="button-row settings-actions">
          <button className="ghost" onClick={refreshCosts}><CircleDollarSign size={18} />刷新费用</button>
          <button className="ghost" onClick={exportCsv} disabled={!canExportCsv}><Download size={18} />导出 CSV</button>
        </div>
        <div className="cost-card">
          <Metric label="今日调用" value={costs.todayCalls.toString()} />
          <Metric label="今日估算" value={`$${costs.todayEstimatedUsd.toFixed(3)}`} />
          <Metric label="本周估算" value={`$${costs.weekEstimatedUsd.toFixed(3)}`} />
        </div>
      </Panel>
    </section>
  );
}

function MistakesPage({
  mistakes,
  wiki,
  searchQuery,
  onDelete,
  onSubjectChange
}: {
  mistakes: MistakeEntry[];
  wiki: KnowledgeWiki[];
  searchQuery: string;
  onDelete: (id: string) => void;
  onSubjectChange: (entry: MistakeEntry, subject: string) => void;
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
  const subjectOptions = buildSubjectOptions(mistakes, wiki, customSubjects);
  const folderSubjects = buildSubjectOptions(visibleMistakes, visibleWiki, customSubjects)
    .filter((subject) =>
      customSubjects.includes(subject) ||
      visibleMistakes.some((entry) => normalizeSubject(entry.subject) === subject) ||
      visibleWiki.some((item) => normalizeSubject(item.subject) === subject)
    );
  const grouped = groupMistakesBySubject(visibleMistakes, folderSubjects);
  const [openSubjects, setOpenSubjects] = useState<Record<string, boolean>>({});
  const [openWiki, setOpenWiki] = useState<Record<string, boolean>>({});
  useEffect(() => saveCustomSubjects(customSubjects), [customSubjects]);
  const addSubject = () => {
    const subject = normalizeSubject(newSubjectName.trim());
    if (!subject) return;
    setCustomSubjects((current) => current.includes(subject) ? current : [...current, subject]);
    setNewSubjectName("");
  };
  return (
    <section className="mistake-section">
      <div className="section-heading">
        <h2>错题本与知识点 Wiki</h2>
        <p>AI 解答后自动沉淀，按学科文件夹归档。</p>
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
              <span>{entries.length} 题 {(openSubjects[subject] ?? true) ? "收起" : "展开"}</span>
            </button>
            {(openSubjects[subject] ?? true) && (
              entries.length > 0 ? (
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
              ) : (
                <p className="empty folder-empty">这个分类还没有错题。</p>
              )
            )}
          </section>
        ))
      )}
      {visibleWiki.length > 0 && (
        <section className="wiki-section">
          <div className="section-heading">
            <h2>知识点 Wiki</h2>
            <p>后端已同步生成 Markdown 文件。</p>
          </div>
          {visibleWiki.map((item) => (
            <article className="wiki-card" key={`${item.subject}-${item.knowledgePoint}`}>
              <button className="folder-heading" onClick={() => setOpenWiki((prev) => ({ ...prev, [item.knowledgePoint]: !prev[item.knowledgePoint] }))}>
                <h3><BookOpen size={18} />{item.knowledgePoint}</h3>
                <span>{item.subject} · {item.count} 次 {openWiki[item.knowledgePoint] ? "收起" : "展开"}</span>
              </button>
              {openWiki[item.knowledgePoint] && (
                <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMathMarkdown(item.markdown) }} />
              )}
            </article>
          ))}
        </section>
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
  return <button className={active === tab ? "tab active" : "tab"} onClick={() => onClick(tab)}>{icon}{label}</button>;
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
  return <div className="timeline">{samples.map((sample, index) => <span key={`${sample.ts}-${index}`} className={sample.state.toLowerCase()} title={`${stateLabel(sample.state)} ${sample.reason}`} />)}</div>;
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
      <label>API Key<input type="password" placeholder="第三方 AI 的 API Key" value={config.apiKey} onChange={(e) => onConfig({ ...config, apiKey: e.target.value })} /></label>
      <label>模型<input value={config.model} onChange={(e) => onConfig({ ...config, model: e.target.value })} placeholder="如 qwen-turbo, gpt-4o-mini" /></label>
      <label>AI 截图范围
        <select value={config.captureMode} onChange={(e) => onConfig({ ...config, captureMode: e.target.value as AiConfig["captureMode"] })}>
          <option value="paper">只截卷面框（快速推荐）</option>
          <option value="full">完整俯拍画面（较慢）</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={config.useStreaming} onChange={(e) => onConfig({ ...config, useStreaming: e.target.checked })} />启用流式首句反馈</label>
      <label className="check"><input type="checkbox" checked={config.enableThinking} onChange={(e) => onConfig({ ...config, enableThinking: e.target.checked })} />启用深度思考（关闭时 prompt 加 /no_think 跳过推理链，响应更快；开启时模型完整推理，答案更准但可能较慢）</label>
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
        <select value={profile.speechVoiceName} onChange={(e) => onProfile({ ...profile, speechVoiceName: e.target.value })}>
          <option value="">自动选择中文声音</option>
          {zhVoices.map((voice) => (
            <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>
          ))}
        </select>
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

function normalizeAiConfig(config: AiConfig): AiConfig {
  if (config.baseUrl.includes(":8000") || config.baseUrl.includes(":8010") || config.baseUrl.includes("localhost:8000") || config.baseUrl.includes("localhost:8010")) {
    return { ...config, baseUrl: "http://127.0.0.1:8012" };
  }
  return config;
}

registerServiceWorker();
createRoot(document.getElementById("root")!).render(<App />);
