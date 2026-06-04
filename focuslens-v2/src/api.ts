import type { AiConfig, CostSummary, KnowledgeWiki, MistakeEntry, TutorProfile } from "./types";

export type TutorRequest = {
  questionAudioText: string;
  imageDataUrl: string | null;
  config: AiConfig;
  profile: TutorProfile;
  trigger: "manual" | "care_offer";
};

export type TutorResponse = {
  answerMarkdown: string;
  mistake: MistakeEntry;
  estimatedCostUsd: number;
};

export type TutorStreamHandlers = {
  onStatus?: (message: string) => void;
  onQuick?: (text: string) => void;
  onToken?: (token: string) => void;
};

export type MemoRequest = {
  imageDataUrl: string | null;
  selectedDate: string;
  config: AiConfig;
  profile: TutorProfile;
};

export type MemoResponse = {
  todos: string[];
  note: string;
};

export type AiConnectionTestResponse = {
  ok: boolean;
  status: number;
  latencyMs: number;
  message: string;
  resolvedUrl: string;
};

export async function askTutor(request: TutorRequest): Promise<TutorResponse> {
  const baseUrl = normalizeBaseUrl(request.config.baseUrl);
  const res = await safeFetch(`${baseUrl}/api/tutor/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  }, baseUrl, 80_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(readApiError(text, `AI 请求失败：${res.status}`));
  }
  return (await res.json()) as TutorResponse;
}

export async function askTutorStream(request: TutorRequest, handlers: TutorStreamHandlers = {}): Promise<TutorResponse> {
  const baseUrl = normalizeBaseUrl(request.config.baseUrl);
  const res = await safeFetch(`${baseUrl}/api/tutor/ask/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify(request)
  }, baseUrl, 80_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(readApiError(text, `AI 流式请求失败：${res.status}`));
  }
  if (!res.body) throw new Error("浏览器不支持读取 AI 流式响应");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalResponse: TutorResponse | null = null;
  let streamError = "";

  const consumeBlock = (block: string) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
    const dataText = block.match(/^data:\s*([\s\S]*)$/m)?.[1]?.trim();
    if (!dataText) return;
    const data = JSON.parse(dataText);
    if (event === "status" && typeof data.message === "string") handlers.onStatus?.(data.message);
    if (event === "quick" && typeof data.text === "string") handlers.onQuick?.(data.text);
    if (event === "token" && typeof data.text === "string") handlers.onToken?.(data.text);
    if (event === "final") finalResponse = data as TutorResponse;
    if (event === "error") streamError = data.message || "AI 教师请求失败";
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() || "";
    blocks.forEach(consumeBlock);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeBlock(buffer);
  if (streamError) throw new Error(streamError);
  if (!finalResponse) throw new Error("AI 流式响应没有返回完整解答");
  return finalResponse;
}

export async function getCostSummary(baseUrl: string): Promise<CostSummary> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await safeFetch(`${normalized}/api/costs/summary`, undefined, normalized, 12_000);
  if (!res.ok) throw new Error("费用数据读取失败");
  return (await res.json()) as CostSummary;
}

export async function recognizeMemoTodos(request: MemoRequest): Promise<MemoResponse> {
  const baseUrl = normalizeBaseUrl(request.config.baseUrl);
  const res = await safeFetch(`${baseUrl}/api/calendar/recognize-memo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  }, baseUrl, 45_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(readApiError(text, `手写备忘录识别失败：${res.status}`));
  }
  return (await res.json()) as MemoResponse;
}

export async function testAiConnection(config: AiConfig): Promise<AiConnectionTestResponse> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const res = await safeFetch(`${baseUrl}/api/ai/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config })
  }, baseUrl, 16_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(readApiError(text, `AI 连接测试失败：${res.status}`));
  }
  return (await res.json()) as AiConnectionTestResponse;
}

export async function fetchMistakes(baseUrl: string): Promise<MistakeEntry[]> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await safeFetch(`${normalized}/api/mistakes`, undefined, normalized, 12_000);
  if (!res.ok) throw new Error("错题本读取失败");
  return (await res.json()) as MistakeEntry[];
}

export async function fetchWiki(baseUrl: string): Promise<KnowledgeWiki[]> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await safeFetch(`${normalized}/api/wiki`, undefined, normalized, 12_000);
  if (!res.ok) throw new Error("知识点 Wiki 读取失败");
  return (await res.json()) as KnowledgeWiki[];
}

export async function updateMistakeRemote(baseUrl: string, entry: MistakeEntry): Promise<MistakeEntry> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await safeFetch(`${normalized}/api/mistakes/${entry.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry)
  }, normalized, 20_000);
  if (!res.ok) throw new Error("错题更新失败");
  return (await res.json()) as MistakeEntry;
}

export async function deleteMistakeRemote(baseUrl: string, id: string): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await safeFetch(`${normalized}/api/mistakes/${id}`, { method: "DELETE" }, normalized, 20_000);
  if (!res.ok) throw new Error("错题删除失败");
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, "");
}

async function safeFetch(url: string, init: RequestInit | undefined, baseUrl: string, timeoutMs: number) {
  const fallbackBaseUrl = getLocalFallbackBaseUrl(baseUrl);
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (primaryError) {
    if (fallbackBaseUrl) {
      try {
        return await fetchWithTimeout(url.replace(baseUrl, fallbackBaseUrl), init, timeoutMs);
      } catch (fallbackError) {
        const health = await probeBackendHealth(baseUrl, fallbackBaseUrl);
        if (health.ok) {
          throw buildBackendTimeoutOrProxyError(primaryError, fallbackError, timeoutMs, baseUrl, fallbackBaseUrl);
        }
      }
    }

    const health = await probeBackendHealth(baseUrl, fallbackBaseUrl);
    if (health.ok) {
      throw buildBackendTimeoutOrProxyError(primaryError, undefined, timeoutMs, baseUrl, fallbackBaseUrl);
    }

    throw new Error(
      `浏览器无法连接 FocusLens 本地后端 ${baseUrl}${fallbackBaseUrl ? ` 或 ${fallbackBaseUrl}` : ""}。第三方 OpenAI-compatible 地址即使已填在“AI 接口地址”，也必须先启动 focuslens-api 本地代理；API Key、跨域、预算和错题保存都由本地后端处理。`
    );
  }
}

async function probeBackendHealth(baseUrl: string, fallbackBaseUrl: string) {
  for (const candidate of [baseUrl, fallbackBaseUrl].filter(Boolean)) {
    try {
      const res = await fetchWithTimeout(`${candidate}/api/health`, undefined, 2500);
      if (res.ok) return { ok: true, baseUrl: candidate };
    } catch {
      // Try the next localhost alias before reporting a connection failure.
    }
  }
  return { ok: false, baseUrl: "" };
}

function buildBackendTimeoutOrProxyError(primaryError: unknown, fallbackError: unknown, timeoutMs: number, baseUrl: string, fallbackBaseUrl: string) {
  const reason = getFetchErrorName(primaryError) || getFetchErrorName(fallbackError);
  const local = `${baseUrl}${fallbackBaseUrl ? ` / ${fallbackBaseUrl}` : ""}`;
  if (reason === "AbortError") {
    return new Error(
      `FocusLens 本地后端是通的，但这次 AI 请求等待超过 ${Math.round(timeoutMs / 1000)} 秒。根因通常是第三方 OpenAI-compatible 模型响应太慢、流式被代理缓冲、图片过大，或模型服务队列阻塞；这不是“8012 没启动”。`
    );
  }
  return new Error(
    `FocusLens 本地后端 ${local} 可以连接，但 AI 请求通道失败。请检查第三方 AI 接口地址、模型服务状态、API Key 和是否允许 HTTP/内网访问。原始错误：${reason || "fetch failed"}`
  );
}

function getFetchErrorName(error: unknown) {
  return error instanceof DOMException ? error.name : error instanceof Error ? error.name || error.message : "";
}

async function legacySafeFetch(url: string, init: RequestInit | undefined, baseUrl: string, timeoutMs: number) {
  const fallbackBaseUrl = getLocalFallbackBaseUrl(baseUrl);
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch {
    if (fallbackBaseUrl) {
      try {
        return await fetchWithTimeout(url.replace(baseUrl, fallbackBaseUrl), init, timeoutMs);
      } catch {
        // Fall through to the clearer connection message.
      }
    }
    throw new Error(
      `浏览器无法连接 FocusLens 本地后端 ${baseUrl}${fallbackBaseUrl ? ` 或 ${fallbackBaseUrl}` : ""}。第三方 OpenAI-compatible 地址即使已填在“AI 接口地址”，也必须先启动 focuslens-api 本地代理；API Key、跨域、预算和错题保存都由本地后端处理。`
    );
  }
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function getLocalFallbackBaseUrl(baseUrl: string) {
  if (baseUrl.includes("127.0.0.1")) return baseUrl.replace("127.0.0.1", "localhost");
  if (baseUrl.includes("localhost")) return baseUrl.replace("localhost", "127.0.0.1");
  return "";
}

function readApiError(text: string, fallback: string) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.detail === "string" ? parsed.detail : text;
  } catch {
    return text;
  }
}
