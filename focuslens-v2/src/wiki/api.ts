import type {
  WikiGraphV2,
  WikiInboxItem,
  WikiPageSummaryV2,
  WikiPageV2,
  WikiTermsResponse,
} from "./types";
import type { OrganizerAiConfig } from "./types";

function base(value: string) {
  return value.replace(/\/+$/, "");
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base(baseUrl)}${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as { detail?: string };
      message = payload.detail || text;
    } catch {
      // Non-JSON errors are already suitable for display.
    }
    throw new Error(message || `Wiki 请求失败：${response.status}`);
  }
  return (await response.json()) as T;
}

function withTerm(path: string, termId = "") {
  if (!termId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}term_id=${encodeURIComponent(termId)}`;
}

export function fetchWikiTerms(baseUrl: string) {
  return request<WikiTermsResponse>(baseUrl, "/api/wiki/terms");
}

export function createWikiTerm(baseUrl: string, label: string) {
  return request<{ term: unknown; terms: WikiTermsResponse }>(baseUrl, "/api/wiki/terms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
}

export function setWikiActiveTerm(baseUrl: string, termId: string) {
  return request<WikiTermsResponse>(baseUrl, "/api/wiki/terms/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term_id: termId }),
  });
}

export function archiveWikiTerm(baseUrl: string, termId: string, archived: boolean) {
  return request<WikiTermsResponse>(baseUrl, `/api/wiki/terms/${encodeURIComponent(termId)}/archive?archived=${archived}`, {
    method: "POST",
  });
}

export function fetchWikiPagesV2(baseUrl: string, termId = "") {
  return request<WikiPageSummaryV2[]>(baseUrl, withTerm("/api/wiki/pages/v2", termId));
}

export function fetchWikiPageV2(baseUrl: string, pageId: string) {
  return request<WikiPageV2>(baseUrl, `/api/wiki/pages/v2/${encodeURIComponent(pageId)}`);
}

export function fetchWikiGraphV2(baseUrl: string, mode: "weak" | "full", subject = "", termId = "") {
  const params = new URLSearchParams({ mode });
  if (subject) params.set("subject", subject);
  if (termId) params.set("term_id", termId);
  return request<WikiGraphV2>(baseUrl, `/api/wiki/graph/v2?${params}`);
}

export function fetchWikiInbox(baseUrl: string) {
  return request<WikiInboxItem[]>(baseUrl, "/api/wiki/inbox");
}

export function confirmWikiInboxItem(baseUrl: string, itemId: string) {
  return request<{ status: "ingested"; page_id: string }>(
    baseUrl,
    `/api/wiki/inbox/${encodeURIComponent(itemId)}/confirm`,
    { method: "POST" },
  );
}

export function deleteWikiInboxItem(baseUrl: string, itemId: string) {
  return request<{ transactionId: string }>(
    baseUrl,
    `/api/wiki/inbox/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  );
}

export function rerunWikiInboxItem(
  baseUrl: string,
  itemId: string,
  decision: any,
  lockedFields: string[] = [],
) {
  return request<any>(
    baseUrl,
    `/api/wiki/inbox/${encodeURIComponent(itemId)}/rerun`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, locked_fields: lockedFields }),
    },
  );
}

export function planWikiOrganization(
  baseUrl: string,
  mode: "incremental" | "full",
  instruction: string,
  subject: string,
  dateRange: "7d" | "30d" | "all",
  aiConfig: OrganizerAiConfig,
) {
  return request<any>(
    baseUrl,
    "/api/wiki/organize/plan",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        instruction,
        subject,
        date_range: dateRange,
        ai_config: {
          aiBaseUrl: aiConfig.aiBaseUrl,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
          enableThinking: aiConfig.enableThinking,
        },
      }),
    },
  );
}

export function executeWikiOrganization(
  baseUrl: string,
  runId: string,
  operationIds: string[],
) {
  return request<{ runId: string; status: "executed"; transactionId: string }>(
    baseUrl,
    "/api/wiki/organize/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, operationIds }),
    },
  );
}

export function undoWikiOrganization(baseUrl: string, runId: string) {
  return request<{ runId: string; status: "undone"; undoId: string }>(
    baseUrl,
    "/api/wiki/organize/undo",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    },
  );
}

export function fetchWikiOrganizeRun(baseUrl: string, runId: string) {
  return request<any>(baseUrl, `/api/wiki/organize/runs/${encodeURIComponent(runId)}`);
}

export function fetchWikiArtifacts(baseUrl: string, termId = "") {
  return request<any[]>(baseUrl, withTerm("/api/wiki/artifacts", termId));
}

export function deleteWikiArtifact(baseUrl: string, pageId: string) {
  return request<any>(baseUrl, `/api/wiki/artifacts/${encodeURIComponent(pageId)}`, {
    method: "DELETE",
  });
}

export function archiveWikiFlashcards(baseUrl: string, pageId: string, archived: boolean) {
  return request<any>(baseUrl, `/api/wiki/artifacts/${encodeURIComponent(pageId)}/archive?archived=${archived}`, {
    method: "POST",
  });
}

export function createPracticePaper(
  baseUrl: string,
  knowledgeIds: string[],
  evidenceIds: string[],
  difficulty: string,
  count: number,
  aiConfig: OrganizerAiConfig,
  termId = "legacy",
) {
  return request<any>(baseUrl, "/api/wiki/papers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      knowledge_ids: knowledgeIds,
      evidence_ids: evidenceIds,
      difficulty,
      count,
      term_id: termId,
      ai_config: {
        aiBaseUrl: aiConfig.aiBaseUrl,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        enableThinking: aiConfig.enableThinking,
      },
    }),
  });
}

export function createFlashcards(
  baseUrl: string,
  knowledgeIds: string[],
  evidenceIds: string[],
  count: number,
  aiConfig: OrganizerAiConfig,
  termId = "legacy",
) {
  return request<any>(baseUrl, "/api/wiki/flashcards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      knowledge_ids: knowledgeIds,
      evidence_ids: evidenceIds,
      count,
      term_id: termId,
      ai_config: {
        aiBaseUrl: aiConfig.aiBaseUrl,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        enableThinking: aiConfig.enableThinking,
      },
    }),
  });
}

export function createStageReport(
  baseUrl: string,
  subject: string,
  dateRange: string,
  aiConfig: OrganizerAiConfig,
  termId = "legacy",
) {
  return request<any>(baseUrl, "/api/wiki/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject,
      date_range: dateRange,
      term_id: termId,
      ai_config: {
        aiBaseUrl: aiConfig.aiBaseUrl,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        enableThinking: aiConfig.enableThinking,
      },
    }),
  });
}

export function patchWikiPage(
  baseUrl: string,
  pageId: string,
  fields: Record<string, any>,
  sections: Record<string, string> = {},
  unlockFields: string[] = [],
) {
  return request<any>(baseUrl, `/api/wiki/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields, sections, unlock_fields: unlockFields }),
  });
}

export function fetchWikiLocalLocations(baseUrl: string) {
  return request<Record<string, string>>(baseUrl, "/api/wiki/local/locations");
}

export function openWikiLocalTarget(baseUrl: string, target: string) {
  return request<{ status: "opened"; target: string; path: string }>(baseUrl, "/api/wiki/local/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
}

export function openWikiLocalPage(baseUrl: string, pageId: string) {
  return request<{ status: "opened"; pageId: string; path: string }>(baseUrl, "/api/wiki/local/open-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_id: pageId }),
  });
}
