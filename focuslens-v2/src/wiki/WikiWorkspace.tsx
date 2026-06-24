import { useEffect, useMemo, useState } from "react";
import { BookOpen, Brain, Library, Sparkles } from "lucide-react";

import {
  archiveWikiTerm,
  createWikiTerm,
  fetchWikiGraphV2,
  fetchWikiInbox,
  fetchWikiPagesV2,
  fetchWikiPageV2,
  fetchWikiTerms,
  setWikiActiveTerm,
} from "./api";
import type {
  WikiGraphV2,
  WikiInboxItem,
  WikiPageSummaryV2,
  WikiPageV2,
  WikiTerm,
  WikiView,
} from "./types";
import { KnowledgeBrowserView } from "./KnowledgeBrowserView";
import { WeakDiagnosisView } from "./WeakDiagnosisView";
import { OrganizerView } from "./OrganizerView";
import type { OrganizerAiConfig } from "./types";
import "./wiki.css";



const viewOptions: Array<{ id: WikiView; label: string; icon: typeof Brain }> = [
  { id: "diagnosis", label: "薄弱诊断", icon: Brain },
  { id: "library", label: "知识库", icon: Library },
  { id: "organizer", label: "AI 整理", icon: Sparkles },
];

const fallbackTerms: WikiTerm[] = [
  {
    id: "legacy",
    label: "未分学期",
    status: "active",
    created_at: "",
    archived_at: "",
  },
];

export function WikiWorkspace({
  baseUrl,
  onError,
  aiConfig,
  onOpenEvidenceInbox,
}: {
  baseUrl: string;
  onError: (message: string) => void;
  aiConfig: OrganizerAiConfig;
  onOpenEvidenceInbox?: () => void;
}) {
  const [view, setView] = useState<WikiView>("diagnosis");
  const [pages, setPages] = useState<WikiPageSummaryV2[]>([]);
  const [graph, setGraph] = useState<WikiGraphV2 | null>(null);
  const [inbox, setInbox] = useState<WikiInboxItem[]>([]);
  const [selectedPage, setSelectedPage] = useState<WikiPageV2 | null>(null);
  const [subject, setSubject] = useState("");
  const [terms, setTerms] = useState<WikiTerm[]>([]);
  const [activeTermId, setActiveTermId] = useState("legacy");
  const [termScope, setTermScope] = useState("legacy");
  const [reviewTermIds, setReviewTermIds] = useState<string[]>([]);
  const [isTermDialogOpen, setIsTermDialogOpen] = useState(false);
  const [termYear, setTermYear] = useState(String(new Date().getFullYear()));
  const [termSeason, setTermSeason] = useState("春季");
  const [termGrade, setTermGrade] = useState("");
  const [termCustomName, setTermCustomName] = useState("");

  const termQuery = termScope === "__review__"
    ? (reviewTermIds.length > 0 ? reviewTermIds.join(",") : "all")
    : termScope;

  const refresh = async () => {
    try {
      const [nextPages, nextGraph, nextInbox] = await Promise.all([
        fetchWikiPagesV2(baseUrl, termQuery),
        fetchWikiGraphV2(baseUrl, "weak", subject, termQuery),
        fetchWikiInbox(baseUrl),
      ]);
      setPages(nextPages);
      setGraph(nextGraph);
      setInbox(nextInbox);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Wiki 读取失败");
    }
  };

  useEffect(() => {
    refresh();
  }, [baseUrl, subject, termQuery]);

  const loadTerms = async () => {
    try {
      const data = await fetchWikiTerms(baseUrl);
      const nextTerms = Array.isArray(data.terms) ? data.terms : fallbackTerms;
      const nextActiveTermId = data.active_term_id || nextTerms[0]?.id || "legacy";
      setTerms(nextTerms);
      setActiveTermId(nextActiveTermId);
      setReviewTermIds((prev) => (prev.length > 0 ? prev : [nextActiveTermId]));
      setTermScope((prev) => (prev === "all" || prev === "__review__" ? prev : nextActiveTermId));
    } catch (error) {
      onError(error instanceof Error ? error.message : "学习阶段读取失败");
    }
  };

  useEffect(() => {
    loadTerms();
  }, [baseUrl]);

  const reviewTerms = terms.filter((term) => reviewTermIds.includes(term.id));
  const currentTerm = termScope === "__review__"
    ? ({ label: `多学期大复习：${reviewTerms.length} 个阶段` } as WikiTerm)
    : terms.find((term) => term.id === termScope);
  const activeTerm = terms.find((term) => term.id === activeTermId);

  const handleTermScopeChange = async (nextTermId: string) => {
    setTermScope(nextTermId);
    if (nextTermId === "all" || nextTermId === "__review__") {
      if (nextTermId === "__review__" && reviewTermIds.length === 0) {
        setReviewTermIds([activeTermId || "legacy"]);
      }
      return;
    }
    try {
      const data = await setWikiActiveTerm(baseUrl, nextTermId);
      setTerms(data.terms);
      setActiveTermId(data.active_term_id || nextTermId);
    } catch (error) {
      onError(error instanceof Error ? error.message : "学习阶段切换失败");
    }
  };

  const handleCreateTermLegacy = async () => {
    const label = window.prompt("请输入新的学习阶段，例如：2026 秋季 · 初一上");
    if (!label?.trim()) return;
    try {
      const data = await createWikiTerm(baseUrl, label.trim());
      setTerms(data.terms.terms);
      setActiveTermId(data.terms.active_term_id);
      setTermScope(data.terms.active_term_id);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "学习阶段创建失败");
    }
  };

  const handleCreateTerm = () => {
    setIsTermDialogOpen(true);
  };

  const handleSubmitTerm = async (event: React.FormEvent) => {
    event.preventDefault();
    const label = termCustomName.trim() || [termYear.trim(), termSeason, termGrade.trim()].filter(Boolean).join(" · ");
    if (!label.trim()) {
      onError("请先填写学期名称。");
      return;
    }
    try {
      const data = await createWikiTerm(baseUrl, label.trim());
      setTerms(data.terms.terms);
      setActiveTermId(data.terms.active_term_id);
      setTermScope(data.terms.active_term_id);
      setReviewTermIds((prev) => Array.from(new Set([...prev, data.terms.active_term_id])));
      setIsTermDialogOpen(false);
      setTermCustomName("");
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "学习阶段创建失败");
    }
  };

  const toggleReviewTerm = (termId: string) => {
    setReviewTermIds((prev) => {
      if (!prev.includes(termId)) return [...prev, termId];
      const next = prev.filter((id) => id !== termId);
      return next.length > 0 ? next : prev;
    });
  };

  const handleArchiveTerm = async () => {
    if (!activeTermId || activeTermId === "legacy") {
      onError("未分学期不能归档，请先新建正式学期。");
      return;
    }
    const label = activeTerm?.label || activeTermId;
    if (!window.confirm(`确定归档“${label}”吗？归档后默认回到未分学期，但仍可在下拉框中调出复习。`)) return;
    try {
      const data = await archiveWikiTerm(baseUrl, activeTermId, true);
      setTerms(data.terms);
      setActiveTermId(data.active_term_id || "legacy");
      setTermScope(data.active_term_id || "legacy");
    } catch (error) {
      onError(error instanceof Error ? error.message : "学习阶段归档失败");
    }
  };

  const subjects = useMemo(
    () => Array.from(new Set(pages.map((page) => page.subject))).filter(Boolean),
    [pages],
  );

  const [editMode, setEditMode] = useState(false);

  const openPage = async (pageId: string) => {
    try {
      setSelectedPage(await fetchWikiPageV2(baseUrl, pageId));
      setEditMode(false);
      setView("library");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Wiki 页面读取失败");
    }
  };

  const openPageForEdit = async (pageId: string) => {
    try {
      setSelectedPage(await fetchWikiPageV2(baseUrl, pageId));
      setEditMode(true);
      setView("library");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Wiki 页面读取失败");
    }
  };

  return (
    <section className="wiki-v2-workspace">
      <header className="wiki-v2-heading">
        <div>
          <span className="eyebrow">Markdown-first learning memory</span>
          <h2>本地 Wiki</h2>
          <p>从学习证据中整理薄弱知识，而不是堆叠每一次对话。</p>
        </div>
        <div className="wiki-v2-heading-stats">
          <strong>{pages.length}</strong><span>知识页</span>
          <button type="button" className="wiki-inbox-shortcut" onClick={onOpenEvidenceInbox}>
            <strong>{inbox.length}</strong><span>待沉淀证据</span>
          </button>
        </div>
      </header>

      <section className={`wiki-term-bar ${termScope === "__review__" ? "review-mode" : ""}`} aria-label="当前学习阶段">
        <div>
          <span>当前学习阶段</span>
          <strong>{termScope === "all" ? "全部历史复习" : currentTerm?.label || "未分学期"}</strong>
          {termScope !== activeTermId && termScope !== "all" ? <em>历史阶段浏览</em> : null}
          {termScope === "all" ? <em>跨学期大复习</em> : null}
        </div>
        <label>
          <span>范围</span>
          <select value={termScope} onChange={(event) => handleTermScopeChange(event.target.value)}>
            <option value="__review__">多学期大复习...</option>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                {term.label}{term.status === "archived" ? "（已归档）" : ""}
              </option>
            ))}
            <option value="all">全部历史 / 大复习</option>
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={handleCreateTerm}>
          新建学期
        </button>
        <button type="button" className="btn-secondary" onClick={handleArchiveTerm} disabled={activeTermId === "legacy"}>
          归档本学期
        </button>
      </section>

      {termScope === "__review__" ? (
        <section className="wiki-term-review-panel" aria-label="多学期大复习范围">
          <span>复习范围</span>
          <div>
            {terms.map((term) => (
              <label key={term.id} className={reviewTermIds.includes(term.id) ? "selected" : ""}>
                <input
                  type="checkbox"
                  checked={reviewTermIds.includes(term.id)}
                  onChange={() => toggleReviewTerm(term.id)}
                />
                {term.label}{term.status === "archived" ? "（已归档）" : ""}
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {isTermDialogOpen ? (
        <div className="wiki-term-modal" role="dialog" aria-modal="true" aria-label="新建学习阶段">
          <form className="wiki-term-dialog" onSubmit={handleSubmitTerm}>
            <header>
              <h3>新建学习阶段</h3>
              <button type="button" className="btn-icon" onClick={() => setIsTermDialogOpen(false)} aria-label="关闭">
                ×
              </button>
            </header>
            <p>给当前学习内容一个明确阶段。之后新知识点、错题证据和学习材料都会默认进入这个阶段。</p>
            <div className="wiki-term-form-grid">
              <label>
                学年
                <input value={termYear} onChange={(event) => setTermYear(event.target.value)} placeholder="2026" />
              </label>
              <label>
                学期
                <select value={termSeason} onChange={(event) => setTermSeason(event.target.value)}>
                  <option value="春季">春季</option>
                  <option value="秋季">秋季</option>
                  <option value="暑假">暑假</option>
                  <option value="寒假">寒假</option>
                  <option value="自定义">自定义</option>
                </select>
              </label>
              <label>
                年级/阶段
                <input value={termGrade} onChange={(event) => setTermGrade(event.target.value)} placeholder="例如：六年级下 / 初一上" />
              </label>
              <label>
                自定义显示名
                <input value={termCustomName} onChange={(event) => setTermCustomName(event.target.value)} placeholder="可选，例如：2026 秋季 · 初一上" />
              </label>
            </div>
            <footer>
              <button type="button" className="btn-secondary" onClick={() => setIsTermDialogOpen(false)}>
                取消
              </button>
              <button type="submit" className="btn-primary">
                创建并切换
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      <nav className="wiki-v2-tabs" aria-label="Wiki sections">
        {viewOptions.map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.id} type="button" className={view === option.id ? "active" : ""} onClick={() => {
              setView(option.id);
              if (option.id !== "library") {
                setEditMode(false);
              }
            }}>
              <Icon size={18} />{option.label}
            </button>
          );
        })}
      </nav>

      {inbox.length > 0 ? (
        <section className="wiki-evidence-handoff">
          <div>
            <strong>还有 {inbox.length} 条学习证据待确认</strong>
            <span>待确认内容已合并到“错题知识点”处理；确认后才会沉淀进 Wiki 知识库。</span>
          </div>
          <button type="button" className="btn-secondary" onClick={onOpenEvidenceInbox}>
            去错题知识点确认
          </button>
        </section>
      ) : null}

      {view === "diagnosis" ? (
        <WeakDiagnosisView
          graph={graph}
          subjects={subjects}
          subject={subject}
          onSubjectChange={setSubject}
          onOpenPage={openPage}
          onEditPage={openPageForEdit}
        />
      ) : null}

      {view === "library" ? (
        <KnowledgeBrowserView
          pages={pages}
          selectedPage={selectedPage}
          onOpenPage={openPage}
          onPageChanged={refresh}
          initialEditMode={editMode}
          baseUrl={baseUrl}
        />
      ) : null}

      {view === "organizer" ? (
        <OrganizerView
          baseUrl={baseUrl}
          subjects={subjects}
          onError={onError}
          aiConfig={aiConfig}
          onWikiChanged={refresh}
        />
      ) : null}
    </section>
  );
}

function Placeholder({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <section className="wiki-v2-placeholder">{icon}<h3>{title}</h3><p>{text}</p></section>;
}
