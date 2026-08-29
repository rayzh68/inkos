import { afterEach, describe, expect, it, vi } from "vitest";
import { StateValidatorAgent } from "../agents/state-validator.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("StateValidatorAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses at most one distinct semantic retry for a returned whitespace result", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: "   \n", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, actualCostUsd: 0.01 } })
      .mockResolvedValueOnce({ content: "PASS", usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 } });
    const onSemanticRetry = vi.fn();

    const result = await agent.validate(
      "Chapter body.", 5, "old", "new", "old hooks", "new hooks", "en", undefined,
      { allowSemanticRetry: true, onSemanticRetry },
    );
    expect(result).toMatchObject({ passed: true, tokenUsage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } });
    expect(result.tokenUsage?.actualCostUsd).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(onSemanticRetry).toHaveBeenCalledTimes(1);
    const retryMessages = chat.mock.calls[1]![0] as ReadonlyArray<{ content: string }>;
    expect(retryMessages.at(-1)?.content).toContain("SEMANTIC_RETRY_1");
  });

  it("stops after the second semantically invalid validator result", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: "not a verdict", usage: ZERO_USAGE });

    await expect(agent.validate(
      "Chapter body.", 5, "old", "new", "old hooks", "new hooks", "en", undefined,
      { allowSemanticRetry: true },
    )).rejects.toThrow("State validator returned invalid response");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("accepts a valid JSON object even when the model appends markdown with extra braces", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "{\"warnings\":[],\"passed\":true}",
          "",
          "## Notes",
          "Trailing markdown can still mention braces like } without changing the verdict.",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "Chapter body.",
      3,
      "old state",
      "new state",
      "old hooks",
      "new hooks",
      "en",
    )).resolves.toEqual({
      warnings: [],
      passed: true,
      repairRequired: false,
      tokenUsage: ZERO_USAGE,
    });
  });

  it("returns a structured repair verdict without classifying warning text in code", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: "REPAIR\n[missing_state_update] 角色已到码头，但状态卡仍在车站",
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "林舟抵达码头。",
      3,
      "位置：家中",
      "位置：车站",
      "H1 未推进",
      "H1 未推进",
    )).resolves.toEqual({
      passed: false,
      repairRequired: true,
      tokenUsage: ZERO_USAGE,
      warnings: [{
        category: "missing_state_update",
        description: "角色已到码头，但状态卡仍在车站",
      }],
    });
  });

  it("passes maxTokens large enough for thinking models to chat()", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 8192,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate("Body.", 1, "old", "new state", "old hooks", "new hooks", "zh");

    const options = chatSpy.mock.calls[0]?.[1] as { maxTokens?: number } | undefined;
    // Must not hardcode a small value like 2048 that starves thinking models
    expect(options?.maxTokens).toBeUndefined();
  });

  it("passes authority truth context into the cross-file validation prompt", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 8192,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate(
      "正文确认：第五条规则才是天黑后不准出宿舍。",
      2,
      "old state",
      "new state: 第一条规则已被批注",
      "old hooks",
      "new hooks",
      "zh",
      {
        storyFrame: "简介里写过：规则一：天黑后不准出宿舍。",
        bookRules: "硬规则：规则编号必须以前文正文确立版本为准。",
        chapterSummaries: "第1章：发现第五条规则的漏洞。",
      },
    );

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("truth files");
    expect(messages[0]?.content).toContain("numbered");
    expect(messages[1]?.content).toContain("## Authority / Cross-Truth Context");
    expect(messages[1]?.content).toContain("规则一：天黑后不准出宿舍");
    expect(messages[1]?.content).toContain("第1章：发现第五条规则的漏洞");
  });

  it("does not silently truncate chapter or authority context before validation", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 8192,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate(
      `${"正文".repeat(7000)}\nCHAPTER_TAIL_MARKER`,
      8,
      "old state",
      "new state",
      "old hooks",
      "new hooks",
      "zh",
      {
        storyFrame: `${"世界设定".repeat(4000)}\nSTORY_FRAME_TAIL_MARKER`,
        bookRules: `${"规则".repeat(3000)}\nBOOK_RULES_TAIL_MARKER`,
        chapterSummaries: `${"摘要".repeat(4000)}\nCHAPTER_SUMMARIES_TAIL_MARKER`,
      },
    );

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[1]?.content).toContain("CHAPTER_TAIL_MARKER");
    expect(messages[1]?.content).toContain("STORY_FRAME_TAIL_MARKER");
    expect(messages[1]?.content).toContain("BOOK_RULES_TAIL_MARKER");
    expect(messages[1]?.content).toContain("CHAPTER_SUMMARIES_TAIL_MARKER");
    expect(messages[1]?.content).not.toContain("[...truncated...]");
  });

  it("throws when the validator model returns an empty response", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: "",
        usage: ZERO_USAGE,
      });

    // Empty response throws (fail-closed)
    await expect(agent.validate(
      "Chapter body.",
      3,
      "old state",
      "new state",
      "old hooks",
      "new hooks",
      "en",
    )).rejects.toThrow("empty response");
  });
});
