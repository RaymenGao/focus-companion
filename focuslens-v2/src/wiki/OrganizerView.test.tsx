// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrganizerView } from "./OrganizerView";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("merge plan summary", () => {
  const mockOnError = vi.fn();
  const baseUrl = "http://localhost:8012";
  const aiConfig = { aiBaseUrl: "http://ai.example/v1", apiKey: "test-key", model: "test-model", enableThinking: false };

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });
  it("renders merge plans as a parent-readable summary without object placeholders", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runId: "run_merge",
        rounds: 1,
        operations: [
          {
            id: "op-merge",
            tool: "merge_pages",
            reason: "这些知识页内容重复",
            risk: "low",
            before: { source_page_ids: ["kp_english_1", "kp_english_2"] },
            after: {
              target_page_id: "kp_english_main",
              short_title: "不定代词辨析",
              full_title: "不定代词辨析与语境用法",
            },
            conflicts: [],
            selected: true,
          },
        ],
        conflicts: [],
        estimatedCostUsd: 0.002,
        sourceHashes: {},
        instruction: "",
      }),
    });

    render(<OrganizerView baseUrl={baseUrl} subjects={["英语"]} onError={mockOnError} aiConfig={aiConfig} />);
    fireEvent.click(screen.getByRole("button", { name: /AI 整理规划/i }));

    expect(await screen.findAllByText("合并知识页")).toHaveLength(2);
    expect(screen.getByText("保留页面")).toBeInTheDocument();
    expect(screen.getByText("将被合并")).toBeInTheDocument();
    expect(screen.getByText("整理后标题")).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
});

describe("OrganizerView", () => {
  const mockOnError = vi.fn();
  const baseUrl = "http://localhost:8012";
  const aiConfig = { aiBaseUrl: "http://ai.example/v1", apiKey: "test-key", model: "test-model", enableThinking: false };

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it("submits the current-run instruction and shows planning results", async () => {
    const mockPlanResponse = {
      runId: "run_test_123",
      rounds: 2,
      operations: [
        {
          id: "op-1",
          tool: "update_fields",
          reason: "Update short title of kp_math_1",
          risk: "low",
          before: { id: "kp_math_1", short_title: "分数裂项" },
          after: { id: "kp_math_1", short_title: "新裂项" },
          conflicts: [],
          selected: true
        }
      ],
      conflicts: [],
      estimatedCostUsd: 0.002,
      sourceHashes: {},
      instruction: "Merge algebra points"
    };

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockPlanResponse,
    });

    render(<OrganizerView baseUrl={baseUrl} subjects={["数学"]} onError={mockOnError} aiConfig={aiConfig} />);

    // 1. Enter instruction
    const input = screen.getByLabelText("本次整理意见") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Merge algebra points" } });
    expect(input.value).toBe("Merge algebra points");

    // 2. Click Plan button
    const planBtn = screen.getByRole("button", { name: /AI 整理规划/i });
    fireEvent.click(planBtn);

    // Verify fetch call parameters
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/wiki/organize/plan"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            mode: "incremental",
            instruction: "Merge algebra points",
            subject: "",
            date_range: "30d",
            ai_config: aiConfig,
          })
        })
      );
    });

    // 3. Verify plan details and operations are displayed
    expect(await screen.findByText(/整理规划详情/i)).toBeInTheDocument();
    expect(screen.getByText(/run_test_123/i)).toBeInTheDocument();
    expect(screen.getAllByText(/更新知识页/i)).toHaveLength(2);
    expect(screen.getByText(/Update short title of kp_math_1/i)).toBeInTheDocument();

    // 4. Verify before/after difference is displayed
    expect(screen.getByText(/短标题/i)).toBeInTheDocument();
    expect(screen.getByText(/分数裂项/i)).toBeInTheDocument();
    expect(screen.getByText(/新裂项/i)).toBeInTheDocument();
    expect(screen.getByText("步骤 2: 方案推演与验证").closest(".stage-step")).toHaveClass("completed");
    expect(screen.getByText("步骤 3: 最终方案生成").closest(".stage-step")).toHaveClass("completed");
    expect(screen.getByText("步骤 4: 等待确认并执行").closest(".stage-step")).not.toHaveClass("completed");
  });

  it("allows operations to be unchecked and only checked operation IDs are sent on execute", async () => {
    const onWikiChanged = vi.fn();
    const mockPlanResponse = {
      runId: "run_test_123",
      rounds: 2,
      operations: [
        {
          id: "op-1",
          tool: "update_fields",
          reason: "Update short title of kp_math_1",
          risk: "low",
          before: { id: "kp_math_1", short_title: "分数裂项" },
          after: { id: "kp_math_1", short_title: "新裂项" },
          conflicts: [],
          selected: true
        },
        {
          id: "op-2",
          tool: "update_fields",
          reason: "Update short title of kp_math_2",
          risk: "low",
          before: { id: "kp_math_2", short_title: "分数基础" },
          after: { id: "kp_math_2", short_title: "基础新" },
          conflicts: [],
          selected: true
        }
      ],
      conflicts: [],
      estimatedCostUsd: 0.002,
      sourceHashes: {},
      instruction: ""
    };

    const mockExecuteResponse = {
      runId: "run_test_123",
      status: "executed",
      transactionId: "tx_12345"
    };

    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPlanResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockExecuteResponse,
      });

    render(<OrganizerView baseUrl={baseUrl} subjects={["数学"]} onError={mockOnError} aiConfig={aiConfig} onWikiChanged={onWikiChanged} />);

    // Get Plan
    fireEvent.click(screen.getByRole("button", { name: /AI 整理规划/i }));
    
    // Wait for operations to load
    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();

    // Uncheck second operation
    fireEvent.click(checkboxes[1]);
    expect(checkboxes[1]).not.toBeChecked();

    // Click execute
    const executeBtn = screen.getByRole("button", { name: /执行已选中操作/i });
    fireEvent.click(executeBtn);

    // Verify execute fetch call only contains op-1
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        expect.stringContaining("/api/wiki/organize/execute"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ runId: "run_test_123", operationIds: ["op-1"] })
        })
      );
    });

    expect(await screen.findByText(/执行成功/i)).toBeInTheDocument();
    expect(screen.getByText("步骤 4: 已写入知识库").closest(".stage-step")).toHaveClass("completed");
    expect(onWikiChanged).toHaveBeenCalledTimes(1);
  });

  it("calls the correct API when undo is clicked", async () => {
    const mockPlanResponse = {
      runId: "run_test_123",
      rounds: 1,
      operations: [
        {
          id: "op-1",
          tool: "update_fields",
          reason: "Update short title of kp_math_1",
          risk: "low",
          before: { id: "kp_math_1", short_title: "分数裂项" },
          after: { id: "kp_math_1", short_title: "新裂项" },
          conflicts: [],
          selected: true
        }
      ],
      conflicts: [],
      estimatedCostUsd: 0.002,
      sourceHashes: {},
      instruction: ""
    };

    const mockExecuteResponse = {
      runId: "run_test_123",
      status: "executed",
      transactionId: "tx_12345"
    };

    const mockUndoResponse = {
      runId: "run_test_123",
      status: "undone",
      undoId: "undo_123"
    };

    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPlanResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockExecuteResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockUndoResponse,
      });

    render(<OrganizerView baseUrl={baseUrl} subjects={["数学"]} onError={mockOnError} aiConfig={aiConfig} />);

    // Get Plan
    fireEvent.click(screen.getByRole("button", { name: /AI 整理规划/i }));

    // Execute
    const executeBtn = await screen.findByRole("button", { name: /执行已选中操作/i });
    fireEvent.click(executeBtn);

    // Undo
    const undoBtn = await screen.findByRole("button", { name: /撤销上一步整理/i });
    fireEvent.click(undoBtn);

    // Verify undo fetch call
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        expect.stringContaining("/api/wiki/organize/undo"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ runId: "run_test_123" })
        })
      );
    });

    expect(await screen.findByText(/整理已成功撤销/i)).toBeInTheDocument();
  });
});
