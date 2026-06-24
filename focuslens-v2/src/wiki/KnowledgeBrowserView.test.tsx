// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { KnowledgeBrowserView, stripEmptyWikiSections, stripWikiFrontmatter } from "./KnowledgeBrowserView";
import type { WikiPageSummaryV2, WikiPageV2 } from "./types";

afterEach(() => {
  cleanup();
});

test("strips JSON frontmatter before rendering a Wiki page", () => {
  expect(stripWikiFrontmatter('---json\n{"id":"page-1"}\n---\n# Title')).toBe("# Title");
});

test("hides empty Wiki sections while preserving sections with content", () => {
  const markdown = "# Title\n\n## 核心概念\n\n有正文\n\n## 相关知识\n\n\n## 学习证据\n\n";

  const cleaned = stripEmptyWikiSections(markdown);

  expect(cleaned).toContain("## 核心概念");
  expect(cleaned).toContain("有正文");
  expect(cleaned).not.toContain("## 相关知识");
  expect(cleaned).not.toContain("## 学习证据");
});


const mockPages: WikiPageSummaryV2[] = [
  {
    id: "page-1",
    type: "knowledge",
    title: "分数乘法",
    shortTitle: "乘法",
    subject: "数学",
    chapter: "分数",
    masteryState: "weak",
    path: "knowledge/math/fraction_mul.md",
  },
  {
    id: "page-2",
    type: "knowledge",
    title: "分数除法",
    shortTitle: "除法",
    subject: "数学",
    chapter: "分数",
    masteryState: "mastered",
    path: "knowledge/math/fraction_div.md",
  },
];

const mockSelectedPage: WikiPageV2 = {
  ...mockPages[0],
  markdown: `
# 分数乘法
这是分数乘法的正文。
有关前置知识，请参阅 [[wiki://page-2|分数除法]] 链接。
  `,
  meta: {
    created_at: "2026-06-13",
    difficulty: "easy",
  },
};

test("renders all subjects in a collapsible tree and opens pages", () => {
  const handleOpenPage = vi.fn();
  render(
    <KnowledgeBrowserView
      pages={mockPages}
      selectedPage={null}
      onOpenPage={handleOpenPage}
    />,
  );

  // Renders subject & chapter
  expect(screen.getByText("数学")).toBeInTheDocument();
  expect(screen.getByText("分数")).toBeInTheDocument();

  // Renders pages under chapters
  const pageButton = screen.getByRole("button", { name: "乘法" });
  expect(pageButton).toBeInTheDocument();
  
  fireEvent.click(pageButton);
  expect(handleOpenPage).toHaveBeenCalledWith("page-1");
});

test("shows markdown content and toggles property drawer", () => {
  const handleOpenPage = vi.fn();
  const { rerender } = render(
    <KnowledgeBrowserView
      pages={mockPages}
      selectedPage={null}
      onOpenPage={handleOpenPage}
    />,
  );

  expect(screen.queryByText("这是分数乘法的正文。")).not.toBeInTheDocument();

  // Rerender with selected page
  rerender(
    <KnowledgeBrowserView
      pages={mockPages}
      selectedPage={mockSelectedPage}
      onOpenPage={handleOpenPage}
    />,
  );

  expect(screen.getAllByText("分数乘法")[0]).toBeInTheDocument();
  expect(screen.getByText(/这是分数乘法的正文/)).toBeInTheDocument();


  // By default, property drawer should be closed (or we can toggle it)
  expect(screen.queryByText("属性抽屉")).not.toBeInTheDocument();

  // Toggle drawer button should exist
  const toggleBtn = screen.getByRole("button", { name: "查看属性" });
  fireEvent.click(toggleBtn);

  // Drawer is open
  expect(screen.getByText("属性抽屉")).toBeInTheDocument();
  expect(screen.getByText("difficulty: easy")).toBeInTheDocument();

  // Toggle again to close
  fireEvent.click(screen.getByRole("button", { name: "隐藏属性" }));
  expect(screen.queryByText("属性抽屉")).not.toBeInTheDocument();
});

test("intercepts wiki:// link clicks and calls onOpenPage", () => {
  const handleOpenPage = vi.fn();
  render(
    <KnowledgeBrowserView
      pages={mockPages}
      selectedPage={mockSelectedPage}
      onOpenPage={handleOpenPage}
    />,
  );

  // Find the wiki:// link parsed by markdown
  const link = screen.getByRole("link", { name: "分数除法" });
  expect(link).toBeInTheDocument();
  expect(link.getAttribute("href")).toBe("wiki://page-2");

  // Click the link
  fireEvent.click(link);
  expect(handleOpenPage).toHaveBeenCalledWith("page-2");
});
