import { useState } from "react";
import { AlertTriangle, CheckCircle2, Play, RotateCcw, Sparkles } from "lucide-react";
import { planWikiOrganization, executeWikiOrganization, undoWikiOrganization } from "./api";
import type { OrganizerAiConfig, WikiOperation, WikiOrganizePlan } from "./types";

interface OrganizerViewProps {
  baseUrl: string;
  subjects: string[];
  onError: (msg: string) => void;
  aiConfig: OrganizerAiConfig;
  onWikiChanged?: () => Promise<void> | void;
}

const TOOL_LABELS: Record<WikiOperation["tool"], string> = {
  create_page: "新建知识页",
  update_fields: "更新知识页",
  merge_pages: "合并知识页",
  move_page: "调整学科或章节",
  add_links: "建立知识关联",
  remove_links: "移除知识关联",
  archive_evidence: "归档学习证据",
  trash_page: "删除知识页",
};

const RISK_LABELS: Record<WikiOperation["risk"], string> = {
  low: "低风险",
  medium: "需要留意",
  high: "高风险",
};

const FIELD_LABELS: Record<string, string> = {
  short_title: "短标题",
  full_title: "完整标题",
  subject: "学科",
  chapter: "章节",
  prerequisites: "前置知识",
  related: "相关知识",
};

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "无";
  if (Array.isArray(value)) return value.join("、") || "无";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function OrganizerView({ baseUrl, subjects, onError, aiConfig, onWikiChanged }: OrganizerViewProps) {
  const [mode, setMode] = useState<"incremental" | "full">("incremental");
  const [selectedSubject, setSelectedSubject] = useState("");
  const [dateRange, setDateRange] = useState("30d");
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<WikiOrganizePlan | null>(null);
  const [selectedOpIds, setSelectedOpIds] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "planned" | "executing" | "executed" | "undoing" | "undone">("idle");
  const [transactionId, setTransactionId] = useState("");

  const handlePlan = async () => {
    setLoading(true);
    setStatus("idle");
    try {
      const result = await planWikiOrganization(
        baseUrl,
        mode,
        instruction,
        selectedSubject,
        dateRange as "7d" | "30d" | "all",
        aiConfig,
      );
      setPlan(result);
      setSelectedOpIds(result.operations.map((op: WikiOperation) => op.id));
      setStatus("planned");
    } catch (err) {
      onError(err instanceof Error ? err.message : "生成规划失败");
      setPlan(null);
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!plan) return;
    setLoading(true);
    setStatus("executing");
    try {
      const res = await executeWikiOrganization(baseUrl, plan.runId, selectedOpIds);
      setTransactionId(res.transactionId);
      setStatus("executed");
      await onWikiChanged?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : "执行整理失败");
      setStatus("planned");
    } finally {
      setLoading(false);
    }
  };

  const handleUndo = async () => {
    if (!plan) return;
    setLoading(true);
    setStatus("undoing");
    try {
      await undoWikiOrganization(baseUrl, plan.runId);
      setStatus("undone");
      await onWikiChanged?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : "撤销整理失败");
      setStatus("executed");
    } finally {
      setLoading(false);
    }
  };

  const toggleOp = (opId: string) => {
    setSelectedOpIds((prev) =>
      prev.includes(opId) ? prev.filter((id) => id !== opId) : [...prev, opId]
    );
  };

  const renderDiff = (op: WikiOperation) => {
    if (op.tool === "merge_pages") {
      const sourceTitles = op.before?.source_page_titles ?? op.before?.source_page_ids;
      const targetTitle = op.after?.target_page_title ?? op.after?.target_page_id;
      const organizedTitle = op.after?.full_title ?? op.after?.short_title ?? targetTitle;
      return (
        <div className="operation-summary">
          <div><span>保留页面</span><strong>{displayValue(targetTitle)}</strong></div>
          <div><span>将被合并</span><strong>{displayValue(sourceTitles)}</strong></div>
          <div><span>整理后标题</span><strong>{displayValue(organizedTitle)}</strong></div>
        </div>
      );
    }

    const keys = Array.from(new Set([...Object.keys(op.before || {}), ...Object.keys(op.after || {})])).filter(
      (k) => !["id", "page_id", "sections", "source_page_titles", "target_page_title"].includes(k)
    );

    const beforeSections = op.before?.sections as Record<string, string> | undefined;
    const afterSections = op.after?.sections as Record<string, string> | undefined;

    return (
      <div className="diff-view">
        {keys.map((key) => {
          const beforeVal = op.before?.[key];
          const afterVal = op.after?.[key];
          if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) return null;

          return (
            <div key={key} className="diff-row">
              <span className="diff-key">{FIELD_LABELS[key] || key}:</span>
              <span className="diff-del">{displayValue(beforeVal)}</span>
              <span className="diff-arrow">→</span>
              <span className="diff-ins">{displayValue(afterVal)}</span>
            </div>
          );
        })}

        {afterSections &&
          Object.keys(afterSections).map((secKey) => {
            const beforeSec = beforeSections?.[secKey] || "";
            const afterSec = afterSections[secKey] || "";
            if (beforeSec === afterSec) return null;

            return (
              <div key={secKey} className="diff-row section-diff">
                <span className="diff-key">## {secKey}:</span>
                <div className="diff-blocks">
                  <div className="diff-del-block">{beforeSec || "无"}</div>
                  <div className="diff-ins-block">{afterSec}</div>
                </div>
              </div>
            );
          })}
      </div>
    );
  };

  const operationGroups = plan
    ? Array.from(new Set(plan.operations.map((operation) => operation.tool))).map((tool) => ({
        tool,
        operations: plan.operations.filter((operation) => operation.tool === tool),
      }))
    : [];

  return (
    <section className="wiki-organizer-view">
      <div className="organizer-controls">
        <div className="controls-row">
          <div className="control-group">
            <label>整理范围</label>
            <div className="scope-selector">
              <button
                type="button"
                className={mode === "incremental" ? "active" : ""}
                onClick={() => setMode("incremental")}
              >
                增量扫描
              </button>
              <button
                type="button"
                className={mode === "full" ? "active" : ""}
                onClick={() => setMode("full")}
              >
                全量整理
              </button>
            </div>
          </div>

          <div className="control-group">
            <label>学科过滤</label>
            <select
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
            >
              <option value="">全部学科</option>
              {subjects.map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label>时间跨度</label>
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
            >
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="all">全部时间</option>
            </select>
          </div>
        </div>

        <div className="control-group full-width">
          <label htmlFor="instruction-input">本次整理意见</label>
          <textarea
            id="instruction-input"
            placeholder="例如：整理并合并分数乘除法中的常见错因，优化各页面前置知识链条"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </div>

        <p className="organizer-batch-note">
          为便于审核和撤销，每轮最多生成 8 项操作。若仍有“待整理”页面，请执行后再次生成下一批规划。
        </p>

        <button
          type="button"
          className="primary-btn plan-btn"
          disabled={loading}
          onClick={handlePlan}
        >
          <Sparkles size={16} /> {loading && status === "idle" ? "规划中..." : "AI 整理规划"}
        </button>
      </div>

      {plan && (
        <div className="organizer-plan-details">
          <header className="plan-header">
            <h3>整理规划详情 (Run ID: {plan.runId})</h3>
            <div className="plan-stats">
              <span>预估成本: <b>${plan.estimatedCostUsd.toFixed(4)}</b></span>
              <span>AI 方案尝试: <b>{plan.rounds} / 3 次</b></span>
            </div>
          </header>

          <div className="agent-stages">
            <div className="stage-step completed">
              <CheckCircle2 size={16} />
              <span>步骤 1: 扫描范围 ({mode === "incremental" ? "增量" : "全量"})</span>
            </div>
            <div className="stage-step completed">
              <CheckCircle2 size={16} />
              <span>步骤 2: 方案推演与验证</span>
            </div>
            <div className="stage-step completed">
              <CheckCircle2 size={16} />
              <span>步骤 3: 最终方案生成</span>
            </div>
            <div className={`stage-step ${
              status === "executed" ? "completed" : status === "executing" ? "active" : status === "undone" ? "undone" : ""
            }`}>
              {status === "undone" ? <RotateCcw size={16} /> : <CheckCircle2 size={16} />}
              <span>
                步骤 4: {
                  status === "executed"
                    ? "已写入知识库"
                    : status === "executing"
                      ? "正在写入知识库"
                      : status === "undone"
                        ? "写入已撤销"
                        : "等待确认并执行"
                }
              </span>
            </div>
          </div>

          {plan.conflicts && plan.conflicts.length > 0 && (
            <div className="plan-conflicts">
              <h4>
                <AlertTriangle size={16} /> 发现冲突 / 受限操作
              </h4>
              <ul>
                {plan.conflicts.map((conflict, idx) => (
                  <li key={idx}>{conflict}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="operation-cards-list">
            {operationGroups.map((group) => (
              <section className="operation-group" key={group.tool}>
                <header><strong>{TOOL_LABELS[group.tool]}</strong><span>{group.operations.length} 项建议</span></header>
                {group.operations.map((op) => (
                  <div key={op.id} className={`operation-card ${selectedOpIds.includes(op.id) ? "selected" : ""}`}>
                <div className="card-header">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedOpIds.includes(op.id)}
                      onChange={() => toggleOp(op.id)}
                      disabled={status !== "planned"}
                    />
                    <strong className="tool-tag">{TOOL_LABELS[op.tool]}</strong>
                  </label>
                  <span className={`risk-tag risk-${op.risk}`}>{RISK_LABELS[op.risk]}</span>
                </div>

                <p className="reason-text"><strong>为什么建议这样整理：</strong>{op.reason}</p>

                {renderDiff(op)}

                {op.conflicts && op.conflicts.length > 0 && (
                  <div className="op-conflicts">
                    <AlertTriangle size={12} />
                    <span>冲突字段：{op.conflicts.join(", ")} (已锁定)</span>
                  </div>
                )}
                  </div>
                ))}
              </section>
            ))}
          </div>

          <div className="plan-actions">
            {status === "planned" && (
              <button
                type="button"
                className="primary-btn execute-btn"
                disabled={loading || selectedOpIds.length === 0}
                onClick={handleExecute}
              >
                <Play size={16} /> 执行已选中操作 ({selectedOpIds.length} 项)
              </button>
            )}

            {status === "executed" && (
              <div className="execution-status-row">
                <span className="success-text">
                  <CheckCircle2 size={16} /> 执行成功 (Transaction ID: {transactionId})
                </span>
                <button
                  type="button"
                  className="secondary-btn undo-btn"
                  disabled={loading}
                  onClick={handleUndo}
                >
                  <RotateCcw size={16} /> 撤销上一步整理
                </button>
              </div>
            )}

            {status === "undone" && (
              <span className="undone-text">
                <RotateCcw size={16} /> 整理已成功撤销，数据已回滚。
              </span>
            )}

            {loading && (status === "executing" || status === "undoing") && (
              <span className="loading-text">正在处理中，请稍候...</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
