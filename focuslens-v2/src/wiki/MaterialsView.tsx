import { useEffect, useState } from "react";
import { renderMathMarkdown } from "../markdown";
import {
  fetchWikiArtifacts,
  deleteWikiArtifact,
  archiveWikiFlashcards,
  createPracticePaper,
  createFlashcards,
  createStageReport,
  fetchWikiPageV2,
  openWikiLocalPage
} from "./api";
import type { OrganizerAiConfig, WikiPageSummaryV2 } from "./types";
import {
  FileText,
  Brain,
  FileCheck2,
  Trash2,
  Archive,
  Eye,
  EyeOff,
  Plus,
  ArrowRight,
  Sparkles,
  HelpCircle,
  TrendingUp,
  AlertTriangle,
  RotateCw
} from "lucide-react";

export function MaterialsView({
  baseUrl,
  aiConfig,
  pages,
  termId = "legacy",
  onError
}: {
  baseUrl: string;
  aiConfig: OrganizerAiConfig;
  pages: WikiPageSummaryV2[];
  termId?: string;
  onError: (message: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"papers" | "flashcards" | "reports">("papers");
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  
  // Selected artifact content
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<any | null>(null);
  const [selectedMarkdown, setSelectedMarkdown] = useState<string>("");
  const [showAnswer, setShowAnswer] = useState(false);
  
  // Flashcard playing state
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  // Form states
  const [selectedKPList, setSelectedKPList] = useState<string[]>([]);
  const [materialSubject, setMaterialSubject] = useState("");
  const [materialChapter, setMaterialChapter] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(5);
  const [reportSubject, setReportSubject] = useState("");
  const [reportDateRange, setReportDateRange] = useState("30d");

  const loadArtifacts = async () => {
    setLoading(true);
    try {
      const list = await fetchWikiArtifacts(baseUrl, termId);
      setArtifacts(list);
    } catch (err) {
      onError(err instanceof Error ? err.message : "获取学习材料列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadArtifacts();
  }, [baseUrl, termId]);

  // Unique subjects/KPs for the forms
  const uniqueKPs = pages.filter((p) => p.type === "knowledge");
  const uniqueSubjects = Array.from(new Set(pages.map((p) => p.subject))).filter(Boolean);
  const materialChapters = Array.from(
    new Set(uniqueKPs.filter((kp) => !materialSubject || kp.subject === materialSubject).map((kp) => kp.chapter))
  ).filter(Boolean);
  const filteredKPs = uniqueKPs.filter((kp) => {
    if (materialSubject && kp.subject !== materialSubject) return false;
    if (materialChapter && kp.chapter !== materialChapter) return false;
    return true;
  });

  useEffect(() => {
    if (uniqueSubjects.length > 0 && !reportSubject) {
      setReportSubject(uniqueSubjects[0]);
    }
  }, [pages]);

  useEffect(() => {
    if (materialChapter && !materialChapters.includes(materialChapter)) {
      setMaterialChapter("");
    }
  }, [materialSubject, pages]);

  const toggleKnowledgePoint = (pageId: string) => {
    setSelectedKPList((prev) =>
      prev.includes(pageId) ? prev.filter((id) => id !== pageId) : [...prev, pageId]
    );
  };

  const filteredKPIds = filteredKPs.map((kp) => kp.id);
  const selectedInFilterCount = filteredKPIds.filter((id) => selectedKPList.includes(id)).length;
  const allFilteredSelected = filteredKPIds.length > 0 && selectedInFilterCount === filteredKPIds.length;

  const selectFilteredKnowledgePoints = () => {
    setSelectedKPList((prev) => Array.from(new Set([...prev, ...filteredKPIds])));
  };

  const clearFilteredKnowledgePoints = () => {
    setSelectedKPList((prev) => prev.filter((id) => !filteredKPIds.includes(id)));
  };

  const renderKnowledgePicker = (label: string) => (
    <div className="material-kp-picker">
      <div className="material-kp-picker-heading">
        <label>{label}</label>
        <span>{selectedInFilterCount} / {filteredKPs.length} 已选</span>
      </div>
      <div className="material-filter-grid">
        <select
          value={materialSubject}
          onChange={(e) => {
            setMaterialSubject(e.target.value);
            setMaterialChapter("");
          }}
          aria-label="学习材料筛选学科"
        >
          <option value="">全部学科</option>
          {uniqueSubjects.map((sub) => (
            <option key={sub} value={sub}>{sub}</option>
          ))}
        </select>
        <select
          value={materialChapter}
          onChange={(e) => setMaterialChapter(e.target.value)}
          aria-label="学习材料筛选章节"
        >
          <option value="">全部章节</option>
          {materialChapters.map((chapter) => (
            <option key={chapter} value={chapter}>{chapter}</option>
          ))}
        </select>
      </div>
      <div className="material-kp-bulk-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={selectFilteredKnowledgePoints}
          disabled={filteredKPs.length === 0 || allFilteredSelected}
        >
          全选当前筛选
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={clearFilteredKnowledgePoints}
          disabled={selectedInFilterCount === 0}
        >
          清空当前筛选
        </button>
      </div>
      <div className="material-kp-list" role="group" aria-label={label}>
        {filteredKPs.map((kp) => (
          <label key={kp.id} className={`material-kp-option ${selectedKPList.includes(kp.id) ? "selected" : ""}`}>
            <input
              type="checkbox"
              checked={selectedKPList.includes(kp.id)}
              onChange={() => toggleKnowledgePoint(kp.id)}
            />
            <span>
              <strong>{kp.shortTitle || kp.title}</strong>
              <em>{kp.subject} / {kp.chapter}</em>
            </span>
          </label>
        ))}
        {filteredKPs.length === 0 ? <p className="empty-text">当前学科和章节下没有知识点。</p> : null}
      </div>
      <small>已选择 {selectedKPList.length} 个知识点</small>
    </div>
  );

  const handleSelectArtifact = async (art: any) => {
    setSelectedId(art.id);
    setSelectedMeta(art.meta);
    setShowAnswer(false);
    setCardIndex(0);
    setFlipped(false);
    try {
      const pageData = await fetchWikiPageV2(baseUrl, art.id);
      setSelectedMarkdown(pageData.markdown);
    } catch (err) {
      onError(err instanceof Error ? err.message : "加载材料详情失败");
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("确定要删除这份学习材料吗？此操作不可逆。")) return;
    try {
      await deleteWikiArtifact(baseUrl, id);
      if (selectedId === id) {
        setSelectedId(null);
        setSelectedMarkdown("");
      }
      await loadArtifacts();
    } catch (err) {
      onError(err instanceof Error ? err.message : "删除材料失败");
    }
  };

  const handleArchiveFlashcardDeck = async (id: string, currentArchived: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await archiveWikiFlashcards(baseUrl, id, !currentArchived);
      await loadArtifacts();
      if (selectedId === id) {
        // reload details to update meta
        const pageData = await fetchWikiPageV2(baseUrl, id);
        setSelectedMeta(pageData.meta);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "归档闪卡失败");
    }
  };

  const handleGeneratePaper = async () => {
    if (selectedKPList.length === 0) {
      onError("请至少选择一个知识点进行测试。");
      return;
    }
    setGenerating(true);
    try {
      const res = await createPracticePaper(baseUrl, selectedKPList, [], difficulty, count, aiConfig, termId);
      await loadArtifacts();
      // Select the newly generated paper
      handleSelectArtifact({ id: res.id, meta: { type: "paper" } });
      setSelectedKPList([]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "生成试卷失败，请检查 AI 配置是否正确或重试");
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateFlashcards = async () => {
    if (selectedKPList.length === 0) {
      onError("请至少选择一个知识点生成记忆卡片。");
      return;
    }
    setGenerating(true);
    try {
      const res = await createFlashcards(baseUrl, selectedKPList, [], count, aiConfig, termId);
      await loadArtifacts();
      handleSelectArtifact({ id: res.id, meta: { type: "flashcards" } });
      setSelectedKPList([]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "生成闪卡失败，请检查 AI 配置是否正确或重试");
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateReport = async () => {
    if (!reportSubject) {
      onError("请先选择报告分析的学科。");
      return;
    }
    setGenerating(true);
    try {
      const res = await createStageReport(baseUrl, reportSubject, reportDateRange, aiConfig, termId);
      await loadArtifacts();
      handleSelectArtifact({ id: res.id, meta: { type: "report" } });
    } catch (err) {
      onError(err instanceof Error ? err.message : "生成报告失败，请检查 AI 配置是否正确或重试");
    } finally {
      setGenerating(false);
    }
  };

  // Filter list by tab
  const filteredArtifacts = artifacts.filter((art) => {
    if (activeTab === "papers") return art.type === "paper" || art.type === "answers";
    if (activeTab === "flashcards") return art.type === "flashcards";
    return art.type === "report";
  });

  // Unique papers (filtering out companion answer files from list)
  const uniquePapersList = filteredArtifacts.filter((art) => {
    if (activeTab === "papers") {
      // only show the main paper in the list
      return art.type === "paper";
    }
    return true;
  });

  const handleArticleClick = async (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (anchor) {
      const href = anchor.getAttribute("href");
      if (href && (href.startsWith("wiki://") || href.startsWith("evidence://"))) {
        e.preventDefault();
        const separatorIndex = href.indexOf("://");
        const pageId = decodeURIComponent(href.slice(separatorIndex + 3));
        try {
          await openWikiLocalPage(baseUrl, pageId);
        } catch (err) {
          onError(err instanceof Error ? err.message : "打开本地 Markdown 文件失败");
        }
      }
    }
  };

  // Render current flashcards list if playing flashcard deck
  const currentCards = selectedMeta?.cards || [];

  return (
    <section className="wiki-v2-materials-layout">
      {/* Sidebar Listing / Generator */}
      <aside className="wiki-v2-materials-sidebar">
        <div className="tab-buttons">
          <button
            type="button"
            className={activeTab === "papers" ? "active" : ""}
            onClick={() => {
              setActiveTab("papers");
              setSelectedId(null);
              setSelectedMarkdown("");
            }}
          >
            <FileText size={16} /> 定制试卷
          </button>
          <button
            type="button"
            className={activeTab === "flashcards" ? "active" : ""}
            onClick={() => {
              setActiveTab("flashcards");
              setSelectedId(null);
              setSelectedMarkdown("");
            }}
          >
            <Brain size={16} /> 记忆闪卡
          </button>
          <button
            type="button"
            className={activeTab === "reports" ? "active" : ""}
            onClick={() => {
              setActiveTab("reports");
              setSelectedId(null);
              setSelectedMarkdown("");
            }}
          >
            <FileCheck2 size={16} /> 学习报告
          </button>
        </div>

        {/* Generator Form */}
        <div className="material-generator-card">
          <h4><Sparkles size={16} /> AI 智能生成</h4>
          
          {activeTab === "papers" && (
            <div className="generator-form">
              {renderKnowledgePicker("选择目标知识点")}
              <div className="form-row">
                <div>
                  <label>难度等级</label>
                  <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                    <option value="easy">基础 (Easy)</option>
                    <option value="medium">中等 (Medium)</option>
                    <option value="hard">强化 (Hard)</option>
                  </select>
                </div>
                <div>
                  <label>题目数量</label>
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  />
                </div>
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={handleGeneratePaper}
                disabled={generating}
              >
                {generating ? "正在生成..." : "一键生成定制试卷"}
              </button>
            </div>
          )}

          {activeTab === "flashcards" && (
            <div className="generator-form">
              {renderKnowledgePicker("选择记忆关联知识点")}
              <label>卡片数量</label>
              <input
                type="number"
                min={1}
                max={20}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={handleGenerateFlashcards}
                disabled={generating}
              >
                {generating ? "正在生成..." : "生成记忆闪卡组"}
              </button>
            </div>
          )}

          {activeTab === "reports" && (
            <div className="generator-form">
              <label>选择分析学科</label>
              <select value={reportSubject} onChange={(e) => setReportSubject(e.target.value)}>
                {uniqueSubjects.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub}
                  </option>
                ))}
              </select>
              <label>分析时间范围</label>
              <select value={reportDateRange} onChange={(e) => setReportDateRange(e.target.value)}>
                <option value="7d">近 7 天</option>
                <option value="30d">近 30 天</option>
                <option value="all">历史全部</option>
              </select>
              <button
                type="button"
                className="btn-primary"
                onClick={handleGenerateReport}
                disabled={generating}
              >
                {generating ? "正在生成..." : "生成阶段性学习报告"}
              </button>
            </div>
          )}
        </div>

        {/* List of artifacts */}
        <div className="artifacts-list-container">
          <h4>已保存的历史材料</h4>
          {loading ? (
            <p className="loading-text">正在加载历史材料...</p>
          ) : uniquePapersList.length === 0 ? (
            <p className="empty-text">当前分类下暂无材料。</p>
          ) : (
            <div className="artifacts-list">
              {uniquePapersList.map((art) => (
                <div
                  key={art.id}
                  className={`artifact-item-card ${selectedId === art.id ? "selected" : ""}`}
                  onClick={() => handleSelectArtifact(art)}
                >
                  <div className="item-header">
                    <span className="item-badge">{art.type}</span>
                    <span className="item-date">{art.created_at?.split("T")[0]}</span>
                  </div>
                  <h5 className="item-title">{art.id.length > 28 ? `${art.id.slice(0, 28)}...` : art.id}</h5>
                  {art.type === "flashcards" && (
                    <div className="item-meta-info">
                      <span>卡数: {art.meta?.cards?.length || 0}</span>
                      {art.meta?.archived && <span className="archived-tag">已归档</span>}
                    </div>
                  )}
                  <div className="item-actions">
                    {art.type === "flashcards" && (
                      <button
                        type="button"
                        className="btn-icon"
                        title={art.meta?.archived ? "取消归档" : "归档闪卡"}
                        onClick={(e) => handleArchiveFlashcardDeck(art.id, !!art.meta?.archived, e)}
                      >
                        <Archive size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-icon btn-danger artifact-delete-btn"
                      title="删除材料"
                      aria-label={`删除材料 ${art.id}`}
                      onClick={(e) => handleDelete(art.id, e)}
                    >
                      <Trash2 size={14} />
                      <span>删除</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Main Material Display area */}
      <main className="wiki-v2-materials-content" onClick={handleArticleClick}>
        {selectedId ? (
          <div className="material-detail-viewer">
            <header className="material-detail-header">
              <div>
                <h2>{selectedId}</h2>
                <div className="detail-meta">
                  <span>类型: {selectedMeta?.type}</span>
                  <span>创建日期: {selectedMeta?.created_at}</span>
                </div>
              </div>
              {selectedMeta?.type === "paper" && (
                <div className="paper-controls">
                  <button
                    type="button"
                    className={`btn-toggle ${!showAnswer ? "active" : ""}`}
                    onClick={async () => {
                      setShowAnswer(false);
                      try {
                        const pageData = await fetchWikiPageV2(baseUrl, selectedId);
                        setSelectedMarkdown(pageData.markdown);
                      } catch (err) {
                        onError("加载试卷题目失败");
                      }
                    }}
                  >
                    <Eye size={16} /> 只看题目
                  </button>
                  <button
                    type="button"
                    className={`btn-toggle ${showAnswer ? "active" : ""}`}
                    onClick={async () => {
                      setShowAnswer(true);
                      try {
                        // Answers is stored at f"{selectedId}_answers"
                        const pageData = await fetchWikiPageV2(baseUrl, `${selectedId}_answers`);
                        setSelectedMarkdown(pageData.markdown);
                      } catch (err) {
                        onError("未找到对应的试卷答案解析文件");
                      }
                    }}
                  >
                    <EyeOff size={16} /> 答案与解析
                  </button>
                </div>
              )}
            </header>

            {/* Flashcard interactive panel */}
            {selectedMeta?.type === "flashcards" && currentCards.length > 0 && (
              <div className="flashcard-interactive-arena">
                <div className="flashcard-playing-indicators">
                  卡片 {cardIndex + 1} / {currentCards.length}
                </div>
                
                {/* Flash Card Body */}
                <div
                  className={`flashcard-card-box ${flipped ? "is-flipped" : ""}`}
                  onClick={() => setFlipped(!flipped)}
                >
                  <div className="card-face card-face-front">
                    <div className="card-hint">
                      <HelpCircle size={16} /> 提示：点击卡片翻看背面
                    </div>
                    <div
                      className="markdown card-content"
                      dangerouslySetInnerHTML={{
                        __html: renderMathMarkdown(currentCards[cardIndex]?.front_markdown || "")
                      }}
                    />
                  </div>
                  <div className="card-face card-face-back">
                    <div className="card-hint">
                      <TrendingUp size={16} /> 正确答案 & 解析步骤
                    </div>
                    <div
                      className="markdown card-content"
                      dangerouslySetInnerHTML={{
                        __html: renderMathMarkdown(currentCards[cardIndex]?.back_markdown || "")
                      }}
                    />
                  </div>
                </div>

                <div className="flashcard-navigation-controls">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setCardIndex((prev) => Math.max(0, prev - 1));
                      setFlipped(false);
                    }}
                    disabled={cardIndex === 0}
                  >
                    上一张
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => setFlipped(!flipped)}
                  >
                    <RotateCw size={14} /> 翻面
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setCardIndex((prev) => Math.min(currentCards.length - 1, prev + 1));
                      setFlipped(false);
                    }}
                    disabled={cardIndex === currentCards.length - 1}
                  >
                    下一张 <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* Markdown rendering area */}
            {selectedMeta?.type !== "flashcards" && (
              <div className="markdown-render-scroll-panel">
                <div
                  className="markdown wiki-markdown"
                  dangerouslySetInnerHTML={{
                    __html: renderMathMarkdown(selectedMarkdown)
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="materials-empty-dashboard">
            <AlertTriangle size={48} className="warn-icon" />
            <h3>请从左侧选择一份材料进行浏览，或生成新的专项材料。</h3>
            <p>
              FocusLens 学习材料页为您自动提取并汇集所有已校验的练习试卷、答案解析、记忆卡片和宏观学习报告。
            </p>
          </div>
        )}
      </main>
    </section>
  );
}
