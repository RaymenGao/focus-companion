// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { WeakDiagnosisView } from "./WeakDiagnosisView";
import type { WikiGraphV2 } from "./types";
import { installCanvasMock } from "./testCanvas";

installCanvasMock();

const graph: WikiGraphV2 = {
  mode: "weak",
  nodes: [
    { id: "s-math", label: "数学", full_title: "数学", type: "subject", subject: "数学", chapter: "", mastery_state: "weak", evidence_count: 1, page_id: "", why: "", recent_evidence: "", review_first: "", next_action: "" },
    { id: "k-1", label: "分数裂项", full_title: "分数裂项相消求和", type: "knowledge", subject: "数学", chapter: "数与代数", mastery_state: "weak", evidence_count: 3, page_id: "kp_math_1", why: "最近重复出错", recent_evidence: "6月8日练习", review_first: "分数基本性质", next_action: "先做一道同型题" },
  ],
  edges: [{ source: "s-math", target: "k-1", type: "contains" }],
};

test("shows an Obsidian-style canvas with global and local graph controls", () => {
  const onOpenPage = vi.fn();
  render(<WeakDiagnosisView graph={graph} subjects={["数学", "英语"]} subject="" onSubjectChange={() => undefined} onOpenPage={onOpenPage} />);

  expect(screen.getByRole("button", { name: "全局图谱" })).toHaveClass("active");
  expect(screen.getByRole("button", { name: "局部图谱" })).toBeDisabled();
  expect(screen.getByLabelText("Obsidian 风格薄弱知识图谱")).toBeInTheDocument();
  expect(screen.getByText("拖动节点 · 滚轮缩放 · 点击查看详情")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(onOpenPage).not.toHaveBeenCalled();
});
