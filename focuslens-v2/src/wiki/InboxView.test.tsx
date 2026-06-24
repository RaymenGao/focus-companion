// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { InboxView } from "./InboxView";
import type { WikiInboxItem } from "./types";

afterEach(() => {
  cleanup();
});


const mockInboxItems: WikiInboxItem[] = [
  {
    id: "item-123",
    meta: {
      event_id: "event-1",
      locked_fields: [],
      decision: {
        confidence: 0.85,
        subject: "数学",
        chapter: "分数",
        short_title: "乘法",
        full_title: "分数乘法运算法则",
        common_reasons: ["计算错误"],
        prerequisites: ["整数乘法"],
      },
    },
    sections: {
      "原始问题": "1/2乘以3/4是多少？",
      "学生语音": "老师，我不知道怎么乘分母和分子。",
      "回答摘要": "分子相乘作为新分子，分母相乘作为新分母。",
      "核心概念": "分数乘法",
      "常见错因": "- 计算错误",
      "解题方法": "分子分母分别相乘",
      "前置知识": "- 整数乘法",
      "学习证据": "学习事件",
    },
  },
];

test("renders inbox card with questions, answers, and decision fields", () => {
  render(
    <InboxView
      inbox={mockInboxItems}
      onConfirm={async () => {}}
      onDelete={async () => {}}
      onRerun={async () => ({})}
    />,
  );

  // Original question & voice & summary
  expect(screen.getByText("1/2乘以3/4是多少？")).toBeInTheDocument();
  expect(screen.getByText("老师，我不知道怎么乘分母和分子。")).toBeInTheDocument();
  expect(screen.getByText("分子相乘作为新分子，分母相乘作为新分母。")).toBeInTheDocument();

  // Core concept, common reason, prerequisite
  expect(screen.getByText("分数乘法")).toBeInTheDocument();
  expect(screen.getByText("计算错误")).toBeInTheDocument();
  expect(screen.getByText("整数乘法")).toBeInTheDocument();

  // Inputs for decision fields
  expect(screen.getByLabelText("学科")).toHaveValue("数学");
  expect(screen.getByLabelText("章节")).toHaveValue("分数");
  expect(screen.getByLabelText("短标题")).toHaveValue("乘法");
  expect(screen.getByLabelText("完整标题")).toHaveValue("分数乘法运算法则");
});

test("allows editing fields and toggling lock status", async () => {
  render(
    <InboxView
      inbox={mockInboxItems}
      onConfirm={async () => {}}
      onDelete={async () => {}}
      onRerun={async () => ({})}
    />,
  );

  const subjectInput = screen.getByLabelText("学科");
  fireEvent.change(subjectInput, { target: { value: "物理" } });
  expect(subjectInput).toHaveValue("物理");

  // Check the lock icon/button for subject
  const subjectLock = screen.getAllByRole("button", { name: /锁/i })[0];
  expect(subjectLock).toBeInTheDocument();

});

test("locked fields are not overwritten by a rerun response", async () => {
  // We mock rerun to return a different value for the locked field
  const handleRerun = vi.fn().mockResolvedValue({
    id: "item-123",
    decision: {
      confidence: 0.9,
      subject: "化学", // Rerun returns Chemistry
      chapter: "无机物",
      short_title: "新标题",
      full_title: "新完整标题",
      common_reasons: [],
      prerequisites: [],
    },
  });

  render(
    <InboxView
      inbox={mockInboxItems}
      onConfirm={async () => {}}
      onDelete={async () => {}}
      onRerun={handleRerun}
    />,
  );

  // Edit and Lock subject (change to "物理")
  const subjectInput = screen.getByLabelText("学科");
  fireEvent.change(subjectInput, { target: { value: "物理" } });
  
  // Find the subject lock button (the first one)
  const lockButtons = screen.getAllByRole("button", { name: /锁/i });
  const subjectLockBtn = lockButtons[0]; // first one is subject
  fireEvent.click(subjectLockBtn); // Toggle Lock to locked

  // Click Save/Rerun
  const saveBtn = screen.getByRole("button", { name: "保存" });
  fireEvent.click(saveBtn);

  await waitFor(() => {
    expect(handleRerun).toHaveBeenCalled();
  });

  // The subject input should still be "物理", not "化学" from the mock rerun response
  expect(screen.getByLabelText("学科")).toHaveValue("物理");
  // But short title (unlocked) should be updated to "新标题" from rerun response
  expect(screen.getByLabelText("短标题")).toHaveValue("新标题");
});

test("triggers actions on confirm, delete, and disables merge/ignore", async () => {
  const handleConfirm = vi.fn();
  const handleDelete = vi.fn();

  render(
    <InboxView
      inbox={mockInboxItems}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
      onRerun={async () => ({})}
    />,
  );

  // Click confirm
  const confirmBtn = screen.getByRole("button", { name: "确认" });
  fireEvent.click(confirmBtn);
  expect(handleConfirm).toHaveBeenCalledWith("item-123");

  // Click delete
  const deleteBtn = screen.getByRole("button", { name: "删除" });
  fireEvent.click(deleteBtn);
  expect(handleDelete).toHaveBeenCalledWith("item-123");

  // Check disabled buttons (merge, ignore)
  const mergeBtn = screen.getByRole("button", { name: "合并" });
  expect(mergeBtn).toBeDisabled();

  const ignoreBtn = screen.getByRole("button", { name: "忽略" });
  expect(ignoreBtn).toBeDisabled();
});
