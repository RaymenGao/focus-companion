// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MaterialsView } from "./MaterialsView";

const mockAiConfig = {
  aiBaseUrl: "http://ai.example/v1",
  apiKey: "test-key",
  model: "test-model",
  enableThinking: false
};

const mockPages = [
  {
    id: "kp_math_1",
    type: "knowledge" as const,
    title: "分数裂项相消",
    shortTitle: "分数裂项",
    subject: "数学",
    chapter: "数与代数",
    masteryState: "weak" as const,
    path: "knowledge/math/kp_math_1.md"
  },
  {
    id: "kp_math_2",
    type: "knowledge" as const,
    title: "小数大小比较",
    shortTitle: "小数比较",
    subject: "数学",
    chapter: "数与代数",
    masteryState: "weak" as const,
    path: "knowledge/math/kp_math_2.md"
  },
  {
    id: "kp_english_1",
    type: "knowledge" as const,
    title: "不定代词辨析",
    shortTitle: "不定代词",
    subject: "英语",
    chapter: "语法",
    masteryState: "learning" as const,
    path: "knowledge/english/kp_english_1.md"
  }
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("renders tab options and handles tab switching", async () => {
  // Mock fetch for listing artifacts
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/artifacts")) {
        return {
          ok: true,
          json: async () => [
            {
              id: "paper_2026_test",
              type: "paper",
              created_at: "2026-06-13T20:00:00",
              meta: { type: "paper" },
              path: "papers/paper_2026_test_paper.md"
            }
          ]
        };
      }
      return { ok: true, json: async () => ({}) };
    })
  );

  render(
    <MaterialsView
      baseUrl="http://127.0.0.1:8012"
      aiConfig={mockAiConfig}
      pages={mockPages}
      onError={() => undefined}
    />
  );

  // Check tab buttons exist
  expect(screen.getByRole("button", { name: "定制试卷" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "记忆闪卡" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "学习报告" })).toBeInTheDocument();

  // Click on 记忆闪卡
  fireEvent.click(screen.getByRole("button", { name: "记忆闪卡" }));
  expect(screen.getByText("生成记忆闪卡组")).toBeInTheDocument();

  // Click on 学习报告
  fireEvent.click(screen.getByRole("button", { name: "学习报告" }));
  expect(screen.getByText("生成阶段性学习报告")).toBeInTheDocument();
});

test("can display paper details and toggle answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/artifacts")) {
        return {
          ok: true,
          json: async () => [
            {
              id: "paper_2026_test",
              type: "paper",
              created_at: "2026-06-13T20:00:00",
              meta: { type: "paper" },
              path: "papers/paper_2026_test_paper.md"
            }
          ]
        };
      }
      if (url.includes("/pages/v2/")) {
        return {
          ok: true,
          json: async () => ({
            id: "paper_2026_test",
            markdown: "### 第 1 题\n这是测试题目内容"
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    })
  );

  render(
    <MaterialsView
      baseUrl="http://127.0.0.1:8012"
      aiConfig={mockAiConfig}
      pages={mockPages}
      onError={() => undefined}
    />
  );

  // Wait for the artifacts to load and click on the paper card
  const card = await screen.findByText("paper_2026_test");
  fireEvent.click(card);

  // Verify that the markdown is rendered
  await waitFor(() => {
    expect(screen.getByText("这是测试题目内容")).toBeInTheDocument();
  });
});

test("hides artifact JSON frontmatter in material detail preview", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/artifacts")) {
      return {
        ok: true,
        json: async () => [
          {
            id: "paper_2026_frontmatter",
            type: "paper",
            created_at: "2026-06-13T20:00:00",
            meta: { type: "paper" },
            path: "papers/paper_2026_frontmatter_paper.md"
          }
        ]
      };
    }
    if (url.includes("/pages/v2/")) {
      return {
        ok: true,
        json: async () => ({
          id: "paper_2026_frontmatter",
          markdown:
            '---json\n{"id":"paper_2026_frontmatter","knowledge_ids":["kp_math_1"],"created_at":"2026-06-13"}\n---\n# FocusLens 定制练习试卷\n\n### 第 1 题\n这是干净题目内容\n\n相关证据：[[evidence://event_1|证据：分数裂项]]'
        })
      };
    }
    if (url.includes("/local/open-page")) {
      return {
        ok: true,
        json: async () => ({ status: "opened", pageId: "event_1", path: "evidence/event_1.md" })
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal(
    "fetch",
    fetchMock
  );

  render(
    <MaterialsView
      baseUrl="http://127.0.0.1:8012"
      aiConfig={mockAiConfig}
      pages={mockPages}
      onError={() => undefined}
    />
  );

  fireEvent.click(await screen.findByText("paper_2026_frontmatter"));

  await waitFor(() => {
    expect(screen.getByText("这是干净题目内容")).toBeInTheDocument();
  });
  expect(screen.queryByText(/knowledge_ids/)).not.toBeInTheDocument();
  expect(screen.queryByText(/created_at/)).not.toBeInTheDocument();
  const evidenceLink = screen.getByRole("link", { name: "证据：分数裂项" });
  expect(evidenceLink).toHaveAttribute("href", "evidence://event_1");

  fireEvent.click(evidenceLink);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8012/api/wiki/local/open-page",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ page_id: "event_1" })
      })
    );
  });
});

test("can select and clear all knowledge points in the current filter", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/artifacts")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    })
  );

  render(
    <MaterialsView
      baseUrl="http://127.0.0.1:8012"
      aiConfig={mockAiConfig}
      pages={mockPages}
      onError={() => undefined}
    />
  );

  fireEvent.change(screen.getByLabelText("学习材料筛选学科"), { target: { value: "数学" } });
  fireEvent.change(screen.getByLabelText("学习材料筛选章节"), { target: { value: "数与代数" } });

  fireEvent.click(screen.getByRole("button", { name: "全选当前筛选" }));
  expect(screen.getByText("已选择 2 个知识点")).toBeInTheDocument();
  expect(screen.getByText("2 / 2 已选")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "清空当前筛选" }));
  expect(screen.getByText("已选择 0 个知识点")).toBeInTheDocument();
  expect(screen.getByText("0 / 2 已选")).toBeInTheDocument();
});
