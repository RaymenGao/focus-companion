import { useState } from "react";
import type { WikiInboxItem } from "./types";

export function InboxView({
  inbox,
  onConfirm,
  onDelete,
  onRerun,
  selectedIds,
  onSelectionChange,
  showBanner = true,
  emptyText = "没有等待确认的内容",
  className = "",
}: {
  inbox: WikiInboxItem[];
  onConfirm: (itemId: string) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onRerun: (itemId: string, decision: any, lockedFields: string[]) => Promise<any>;
  selectedIds?: Set<string>;
  onSelectionChange?: (itemId: string, selected: boolean) => void;
  showBanner?: boolean;
  emptyText?: string;
  className?: string;
}) {
  return (
    <section className={`wiki-v2-inbox-wrapper ${className}`}>
      {showBanner ? <div className="wiki-inbox-banner" style={{ padding: "16px", borderRadius: "6px", backgroundColor: "#f0f7ff", borderLeft: "4px solid #0066cc", marginBottom: "20px", fontSize: "0.95rem", color: "#333", lineHeight: "1.5" }}>
        <strong>📥 待确认箱说明：</strong>
        <p style={{ margin: "4px 0 0 0" }}>
          这里存放着 AI 不够确信该如何自动归类的学习记录。当置信度低于安全阈值时，AI 会把内容暂存在这里。你可以检查下面的卡片，编辑、保存正确的学科/章节或删除该条目。确认后，它会被正式归档至知识库。
        </p>
      </div> : null}

      {inbox.map((item) => (
        <InboxCard
          key={item.id}
          item={item}
          onConfirm={onConfirm}
          onDelete={onDelete}
          onRerun={onRerun}
          selected={selectedIds?.has(item.id) ?? false}
          onSelectionChange={onSelectionChange}
        />
      ))}
      {inbox.length === 0 && emptyText ? <p className="empty">{emptyText}</p> : null}
    </section>
  );
}

function InboxCard({
  item,
  onConfirm,
  onDelete,
  onRerun,
  selected,
  onSelectionChange,
}: {
  item: WikiInboxItem;
  onConfirm: (itemId: string) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onRerun: (itemId: string, decision: any, lockedFields: string[]) => Promise<any>;
  selected?: boolean;
  onSelectionChange?: (itemId: string, selected: boolean) => void;
}) {
  const [subject, setSubject] = useState(item.meta.decision.subject || "");
  const [chapter, setChapter] = useState(item.meta.decision.chapter || "");
  const [shortTitle, setShortTitle] = useState(item.meta.decision.short_title || "");
  const [fullTitle, setFullTitle] = useState(item.meta.decision.full_title || "");
  const [lockedFields, setLockedFields] = useState<string[]>(item.meta.locked_fields || []);
  const [saving, setSaving] = useState(false);

  const toggleLock = (fieldName: string) => {
    setLockedFields((prev) =>
      prev.includes(fieldName) ? prev.filter((f) => f !== fieldName) : [...prev, fieldName]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updatedDecision = {
        ...item.meta.decision,
        subject,
        chapter,
        short_title: shortTitle,
        full_title: fullTitle,
      };
      const response = await onRerun(item.id, updatedDecision, lockedFields);
      if (response && response.decision) {
        const d = response.decision;
        if (!lockedFields.includes("subject")) setSubject(d.subject || "");
        if (!lockedFields.includes("chapter")) setChapter(d.chapter || "");
        if (!lockedFields.includes("short_title")) setShortTitle(d.short_title || "");
        if (!lockedFields.includes("full_title")) setFullTitle(d.full_title || "");
      }
    } catch (error) {
      console.error("保存修改失败", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="wiki-v2-inbox-card" key={item.id}>
      <header className="card-header">
        {onSelectionChange ? (
          <label className="inbox-select-check">
            <input type="checkbox" checked={selected} onChange={(event) => onSelectionChange(item.id, event.target.checked)} />
            选择沉淀
          </label>
        ) : null}
        <span className="eyebrow">置信度 {Math.round((item.meta.decision.confidence || 0) * 100)}%</span>
        <h3>{shortTitle || "待确认知识点"}</h3>
      </header>

      {/* Text segments */}
      <section className="card-sections">
        {item.sections["原始问题"] && (
          <div className="section-block">
            <strong>原始问题</strong>
            <p>{item.sections["原始问题"]}</p>
          </div>
        )}
        {item.sections["学生语音"] && (
          <div className="section-block">
            <strong>学生语音</strong>
            <p>{item.sections["学生语音"]}</p>
          </div>
        )}
        {item.sections["回答摘要"] && (
          <div className="section-block">
            <strong>回答摘要</strong>
            <p>{item.sections["回答摘要"]}</p>
          </div>
        )}
        {item.sections["核心概念"] && (
          <div className="section-block">
            <strong>核心概念</strong>
            <p>{item.sections["核心概念"]}</p>
          </div>
        )}
        {item.sections["常见错因"] && (
          <div className="section-block">
            <strong>常见错因</strong>
            <p>{item.sections["常见错因"].replace(/^- /, "")}</p>
          </div>
        )}
        {item.sections["前置知识"] && (
          <div className="section-block">
            <strong>前置知识</strong>
            <p>{item.sections["前置知识"].replace(/^- /, "")}</p>
          </div>
        )}
      </section>

      {/* Editable Fields */}
      <section className="card-fields">
        <div className="field-group">
          <label htmlFor={`subj-${item.id}`}>学科</label>
          <div className="field-input-wrapper">
            <input
              id={`subj-${item.id}`}
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            <button
              type="button"
              className={`lock-btn ${lockedFields.includes("subject") ? "locked" : ""}`}
              onClick={() => toggleLock("subject")}
              title={lockedFields.includes("subject") ? "解锁该字段" : "锁定该字段"}
            >
              {lockedFields.includes("subject") ? "🔒 锁" : "🔓 锁"}
            </button>
          </div>
        </div>

        <div className="field-group">
          <label htmlFor={`ch-${item.id}`}>章节</label>
          <div className="field-input-wrapper">
            <input
              id={`ch-${item.id}`}
              type="text"
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
            />
            <button
              type="button"
              className={`lock-btn ${lockedFields.includes("chapter") ? "locked" : ""}`}
              onClick={() => toggleLock("chapter")}
              title={lockedFields.includes("chapter") ? "解锁该字段" : "锁定该字段"}
            >
              {lockedFields.includes("chapter") ? "🔒 锁" : "🔓 锁"}
            </button>
          </div>
        </div>

        <div className="field-group">
          <label htmlFor={`st-${item.id}`}>短标题</label>
          <div className="field-input-wrapper">
            <input
              id={`st-${item.id}`}
              type="text"
              value={shortTitle}
              onChange={(e) => setShortTitle(e.target.value)}
            />
            <button
              type="button"
              className={`lock-btn ${lockedFields.includes("short_title") ? "locked" : ""}`}
              onClick={() => toggleLock("short_title")}
              title={lockedFields.includes("short_title") ? "解锁该字段" : "锁定该字段"}
            >
              {lockedFields.includes("short_title") ? "🔒 锁" : "🔓 锁"}
            </button>
          </div>
        </div>

        <div className="field-group">
          <label htmlFor={`ft-${item.id}`}>完整标题</label>
          <div className="field-input-wrapper">
            <input
              id={`ft-${item.id}`}
              type="text"
              value={fullTitle}
              onChange={(e) => setFullTitle(e.target.value)}
            />
            <button
              type="button"
              className={`lock-btn ${lockedFields.includes("full_title") ? "locked" : ""}`}
              onClick={() => toggleLock("full_title")}
              title={lockedFields.includes("full_title") ? "解锁该字段" : "锁定该字段"}
            >
              {lockedFields.includes("full_title") ? "🔒 锁" : "🔓 锁"}
            </button>
          </div>
        </div>
      </section>

      {/* Action Buttons */}
      <footer className="card-actions">
        <div className="action-row">
          <button
            type="button"
            className="primary-btn"
            onClick={() => onConfirm(item.id)}
          >
            确认
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "保存中..." : "保存"}
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => onDelete(item.id)}
          >
            删除
          </button>
        </div>
        <div className="action-row missing-apis">
          <button
            type="button"
            className="ghost-btn"
            disabled
            title="后端合并接口缺失"
          >
            合并
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled
            title="后端重新分析接口缺失"
          >
            重新分析
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled
            title="后端忽略接口缺失"
          >
            忽略
          </button>
        </div>
      </footer>

    </article>
  );
}
