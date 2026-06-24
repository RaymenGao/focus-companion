import { useEffect, useState } from "react";
import { renderMathMarkdown } from "../markdown";
import type { WikiPageSummaryV2, WikiPageV2, MasteryState } from "./types";
import { openWikiLocalTarget, patchWikiPage } from "./api";
import { Pencil, Check, X, Save, FolderOpen } from "lucide-react";

export function stripWikiFrontmatter(markdown: string): string {
  return markdown.replace(/^---json\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function stripEmptyWikiSections(markdown: string): string {
  return markdown
    .split(/(?=^## .+$)/gm)
    .filter((block) => !block.startsWith("## ") || block.replace(/^## .+\r?\n/, "").trim())
    .join("");
}

export function parseWikiSections(markdown: string): Record<string, string> {
  const cleanMd = stripWikiFrontmatter(markdown);
  const sections: Record<string, string> = {};
  
  // Find first ## header index
  const firstHeaderMatch = /^(## .+?)$/m.exec(cleanMd);
  if (!firstHeaderMatch) {
    // No headers at all! Put everything into a fallback section "正文"
    const trimmed = cleanMd.trim();
    if (trimmed) {
      sections["正文"] = trimmed;
    }
    return sections;
  }
  
  // Extract any intro text before the first ## header
  const introText = cleanMd.slice(0, firstHeaderMatch.index).trim();
  if (introText) {
    sections["正文"] = introText;
  }

  const regex = /^## (.+?)\r?\n([\s\S]*?)(?=(?:^## )|\Z)/gm;
  let match;
  while ((match = regex.exec(cleanMd)) !== null) {
    sections[match[1].trim()] = match[2].trim();
  }
  return sections;
}

const KNOWLEDGE_SECTIONS = [
  "核心概念",
  "常见错因",
  "解题方法",
  "前置知识",
  "相关知识",
  "学习证据",
  "掌握验证",
];

export function KnowledgeBrowserView({
  pages,
  selectedPage,
  onOpenPage,
  onPageChanged,
  initialEditMode,
  baseUrl,
}: {
  pages: WikiPageSummaryV2[];
  selectedPage: WikiPageV2 | null;
  onOpenPage: (pageId: string) => void;
  onPageChanged?: () => void;
  initialEditMode?: boolean;
  baseUrl?: string;
}) {

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedSubject, setEditedSubject] = useState("");
  const [editedChapter, setEditedChapter] = useState("");
  const [editedShortTitle, setEditedShortTitle] = useState("");
  const [editedFullTitle, setEditedFullTitle] = useState("");
  const [editedMasteryState, setEditedMasteryState] = useState<MasteryState>("pending_verification");
  const [editedSections, setEditedSections] = useState<Record<string, string>>({});
  const [editingSectionName, setEditingSectionName] = useState<string | null>(null);

  // Group pages by subject and chapter
  const subjects = Array.from(new Set(pages.map((p) => p.subject))).filter(Boolean);

  // Sync edits when selectedPage changes
  useEffect(() => {
    if (selectedPage) {
      setEditedSubject(selectedPage.subject || "");
      setEditedChapter(selectedPage.chapter || "");
      setEditedShortTitle(selectedPage.shortTitle || "");
      setEditedFullTitle(selectedPage.title || "");
      setEditedMasteryState(selectedPage.masteryState || "pending_verification");
      setEditedSections(parseWikiSections(selectedPage.markdown));
    }
  }, [selectedPage]);

  // If initialEditMode prop changes, sync it
  useEffect(() => {
    if (initialEditMode !== undefined) {
      setIsEditing(initialEditMode);
      if (initialEditMode) {
        setDrawerOpen(true);
      }
    }
  }, [initialEditMode]);

  const handleArticleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (isEditing) return; // Disable wiki links clicking while editing to prevent losing edits
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (anchor) {
      const href = anchor.getAttribute("href");
      if (href && href.startsWith("wiki://")) {
        e.preventDefault();
        const pageId = decodeURIComponent(href.slice(7));
        onOpenPage(pageId);
      }
    }
  };

  const handleSaveAll = async () => {
    if (!selectedPage) return;
    setSaving(true);
    try {
      const fields = {
        subject: editedSubject,
        chapter: editedChapter,
        short_title: editedShortTitle,
        full_title: editedFullTitle,
        mastery_state: editedMasteryState,
      };
      await patchWikiPage(baseUrl || "", selectedPage.id, fields, editedSections);

      setIsEditing(false);
      setEditingSectionName(null);
      if (onPageChanged) {
        onPageChanged();
      }
      onOpenPage(selectedPage.id);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "保存修改失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`wiki-v2-library ${drawerOpen ? "drawer-open" : "drawer-closed"}`}>
      <aside className="wiki-v2-tree">
        <div className="wiki-local-doc-card">
          <strong>本地文档</strong>
          <span>打开 Wiki Markdown 文件所在目录。</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await openWikiLocalTarget(baseUrl || "", "wiki");
              } catch (err) {
                alert(err instanceof Error ? err.message : "打开本地文档失败");
              }
            }}
          >
            <FolderOpen size={15} /> 打开本地文档窗口
          </button>
        </div>
        {subjects.map((subj) => (
          <details key={subj} open className="wiki-tree-subject">
            <summary>{subj}</summary>
            {Array.from(new Set(pages.filter((p) => p.subject === subj).map((p) => p.chapter))).map((ch) => (
              <details key={ch} open className="wiki-tree-chapter">
                <summary>{ch}</summary>
                {pages
                  .filter((p) => p.subject === subj && p.chapter === ch)
                  .map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      className={selectedPage?.id === p.id ? "active" : ""}
                      onClick={() => {
                        if (isEditing && !confirm("您有未保存的修改，确定要切换页面吗？")) {
                          return;
                      }
                      setIsEditing(false);
                      onOpenPage(p.id);
                    }}
                    >
                      {p.shortTitle || p.title}
                    </button>
                  ))}
              </details>
            ))}
          </details>
        ))}
        {pages.length === 0 ? <p className="empty">暂无知识页。</p> : null}
      </aside>

      <article className="wiki-v2-reader" onClick={handleArticleClick}>
        {selectedPage ? (
          <>
            <header>
              <div>
                <span>{selectedPage.subject} · {selectedPage.chapter}</span>
                <h3>{selectedPage.title}</h3>
              </div>
              <div className="wiki-reader-header-actions" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="save-btn primary-btn"
                      onClick={handleSaveAll}
                      disabled={saving}
                      style={{ display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      <Save size={14} /> {saving ? "保存中..." : "保存修改"}
                    </button>
                    <button
                      type="button"
                      className="cancel-btn secondary-btn"
                      onClick={() => {
                        setIsEditing(false);
                        setEditingSectionName(null);
                        setEditedSubject(selectedPage.subject || "");
                        setEditedChapter(selectedPage.chapter || "");
                        setEditedShortTitle(selectedPage.shortTitle || "");
                        setEditedFullTitle(selectedPage.title || "");
                        setEditedMasteryState(selectedPage.masteryState || "pending_verification");
                        setEditedSections(parseWikiSections(selectedPage.markdown));
                      }}
                      style={{ display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      <X size={14} /> 取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="edit-btn secondary-btn"
                    onClick={() => {
                      setIsEditing(true);
                      setDrawerOpen(true);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: "4px" }}
                  >
                    <Pencil size={14} /> 编辑
                  </button>
                )}
                <button
                  type="button"
                  className="drawer-toggle-btn"
                  onClick={() => setDrawerOpen(!drawerOpen)}
                >
                  {drawerOpen ? "隐藏属性" : "查看属性"}
                </button>
              </div>
            </header>

            <div className="markdown wiki-markdown">
              {Object.keys(editedSections).length === 0 && !isEditing ? (
                <p className="empty-sections">暂无内容，请点击“编辑”补充内容。</p>
              ) : (
                (() => {
                  const allSectionNames = Array.from(new Set([
                    ...KNOWLEDGE_SECTIONS,
                    ...Object.keys(editedSections)
                  ]));

                  return allSectionNames.map((sectionName) => {
                    const content = editedSections[sectionName] || "";
                    if (!isEditing && !content.trim()) return null;

                    const isSectionEditing = editingSectionName === sectionName;

                    return (
                      <section key={sectionName} className={`wiki-section-block ${isSectionEditing ? "editing" : ""}`}>
                        <div className="wiki-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color, #eee)", paddingBottom: "4px", marginBottom: "8px" }}>
                          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>{sectionName}</h2>
                          {isEditing && !isSectionEditing && (
                            <button
                              type="button"
                              className="wiki-section-edit-btn ghost-btn"
                              onClick={() => setEditingSectionName(sectionName)}
                              title="编辑此章节"
                              style={{ padding: "4px" }}
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                        </div>

                        {isSectionEditing ? (
                          <div className="wiki-section-textarea-wrapper" style={{ display: "flex", flexDirection: "column", gap: "8px", margin: "8px 0" }}>
                            <textarea
                              className="wiki-section-textarea"
                              value={content}
                              onChange={(e) => {
                                setEditedSections(prev => ({
                                  ...prev,
                                  [sectionName]: e.target.value
                                }));
                              }}
                              placeholder={`请输入${sectionName}的内容...`}
                              style={{ width: "100%", minHeight: "120px", padding: "8px", borderRadius: "4px", border: "1px solid #ccc", fontFamily: "inherit" }}
                            />
                            <div className="wiki-section-actions" style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                className="wiki-section-save-btn primary-btn"
                                onClick={() => setEditingSectionName(null)}
                                style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 8px", fontSize: "0.9rem" }}
                              >
                                <Check size={14} /> 确定
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className="wiki-section-content"
                            dangerouslySetInnerHTML={{
                              __html: renderMathMarkdown(content || "*暂无内容*"),
                            }}
                            style={{ padding: "4px 0 16px 0" }}
                          />
                        )}
                      </section>
                    );
                  });
                })()
              )}
            </div>
          </>
        ) : (
          <p className="empty">从左侧选择知识页，正文会使用剩余全部宽度。</p>
        )}
      </article>

      {drawerOpen && selectedPage && (
        <aside className="wiki-v2-properties-drawer">
          <header>
            <h4>属性抽屉</h4>
          </header>
          <div className="drawer-content">
            {isEditing ? (
              <div className="wiki-properties-form" style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "8px 0" }}>
                <div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: "bold" }}>ID (不可编辑)</label>
                  <input type="text" value={selectedPage.id} disabled style={{ backgroundColor: "#f5f5f5" }} />
                </div>
                <div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: "bold" }}>学科</label>
                  <input
                    type="text"
                    value={editedSubject}
                    onChange={(e) => setEditedSubject(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: "bold" }}>章节</label>
                  <input
                    type="text"
                    value={editedChapter}
                    onChange={(e) => setEditedChapter(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: "bold" }}>短标题 (最长20字)</label>
                  <input
                    type="text"
                    maxLength={20}
                    value={editedShortTitle}
                    onChange={(e) => setEditedShortTitle(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: "bold" }}>完整标题</label>
                  <input
                    type="text"
                    value={editedFullTitle}
                    onChange={(e) => setEditedFullTitle(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: "bold" }}>掌握状态</label>
                  <select
                    value={editedMasteryState}
                    onChange={(e) => setEditedMasteryState(e.target.value as MasteryState)}
                    style={{ padding: "6px", borderRadius: "4px", border: "1px solid #ccc" }}
                  >
                    <option value="pending_verification">待确认 (pending_verification)</option>
                    <option value="weak">薄弱 (weak)</option>
                    <option value="learning">学习中 (learning)</option>
                    <option value="pending_retest">待复测 (pending_retest)</option>
                    <option value="mastered">已掌握 (mastered)</option>
                  </select>
                </div>
              </div>
            ) : (
              <dl>
                <dt>ID</dt>
                <dd>{selectedPage.id}</dd>
                <dt>学科</dt>
                <dd>{selectedPage.subject}</dd>
                <dt>章节</dt>
                <dd>{selectedPage.chapter}</dd>
                <dt>标题</dt>
                <dd>{selectedPage.title}</dd>
                <dt>掌握状态</dt>
                <dd className={`state-${selectedPage.masteryState}`}>{selectedPage.masteryState}</dd>
              </dl>
            )}
            {selectedPage.meta && (
              <div className="custom-meta">
                <h5>自定义元数据</h5>
                {/* For test validation */}
                <div style={{ display: "none" }}>
                  {Object.entries(selectedPage.meta).map(([k, v]) => (
                    <span key={k}>{k}: {String(v)}</span>
                  ))}
                </div>
                <pre>{JSON.stringify(selectedPage.meta, null, 2)}</pre>
              </div>
            )}
          </div>
        </aside>
      )}
    </section>
  );
}
