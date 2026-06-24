// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { WikiWorkspace } from "./WikiWorkspace";
import { installCanvasMock } from "./testCanvas";

installCanvasMock();

test("shows Wiki as a focused knowledge workspace", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.includes("/graph/")) return { mode: "weak", nodes: [], edges: [] };
      if (url.includes("/terms")) return { active_term_id: "legacy", terms: [] };
      return [];
    },
    text: async () => "",
  })));

  render(
    <WikiWorkspace
      baseUrl="http://127.0.0.1:8012"
      aiConfig={{ aiBaseUrl: "http://ai.example/v1", apiKey: "test", model: "test", enableThinking: false }}
      onError={() => undefined}
    />,
  );

  expect(screen.getByRole("button", { name: "薄弱诊断" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "知识库" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "AI 整理" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "学习材料" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "待确认箱" })).not.toBeInTheDocument();
});
