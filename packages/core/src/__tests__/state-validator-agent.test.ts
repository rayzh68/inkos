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
          "{\"disposition\":\"PASS\",\"warnings\":[]}",
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
      disposition: "PASS",
      tokenUsage: ZERO_USAGE,
    });
  });

  it("returns a structured state-only repair verdict without classifying warning text in code", async () => {
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
        content: JSON.stringify({
          disposition: "STATE_REPAIR_REQUIRED",
          warnings: [{ category: "missing_state_update", description: "角色已到码头，但状态卡仍在车站" }],
        }),
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
      disposition: "STATE_REPAIR_REQUIRED",
      tokenUsage: ZERO_USAGE,
      warnings: [{
        category: "missing_state_update",
        description: "角色已到码头，但状态卡仍在车站",
      }],
    });
  });

  it("does not auto-pass completely unchanged truth when the chapter implies a missing settlement update", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          disposition: "STATE_REPAIR_REQUIRED",
          warnings: [{ category: "missing_state_update", description: "The chapter advances H1, but every truth surface is unchanged." }],
        }),
        usage: ZERO_USAGE,
      });

    const result = await agent.validate(
      "The chapter explicitly advances H1.", 10,
      "location: tower", "location: tower", "H1 pending", "H1 pending", "en",
      { chapterSummaries: "Chapter 9 ends with H1 pending." }, undefined,
      { oldLedger: "H1 pending", newLedger: "H1 pending" },
    );

    expect(result).toMatchObject({ disposition: "STATE_REPAIR_REQUIRED", passed: false });
    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0]![0] as ReadonlyArray<{ content: string }>;
    expect(messages[1]?.content).toContain("location: tower");
    expect(messages[1]?.content).toContain("H1 pending");
  });

  it("validates a ledger-only change when state and hooks are unchanged", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: JSON.stringify({ disposition: "PASS", warnings: [] }), usage: ZERO_USAGE });

    await agent.validate(
      "The chapter advances H1.", 10,
      "location: tower", "location: tower", "H1 pending", "H1 pending", "en",
      undefined, undefined,
      { oldLedger: "H1 pending", newLedger: "H1 progressing" },
    );

    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0]![0] as ReadonlyArray<{ content: string }>;
    expect(messages[1]?.content).toContain("Particle Ledger Changes");
    expect(messages[1]?.content).toContain("H1 progressing");
  });

  it("accepts a proven prose-authority contradiction only with both structured evidence surfaces", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          disposition: "CONTENT_REPAIR_REQUIRED",
          warnings: [{ category: "ongoing_authority_contradiction", description: "The candidate contradicts committed continuity." }],
          proseAuthorityEvidence: {
            status: "PROVEN",
            currentProse: ["The current candidate keeps the new condition."],
            committedAuthority: ["The committed summary keeps the prior condition."],
          },
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "The current candidate keeps the new condition.", 12,
      "prior condition", "new condition", "old hooks", "new hooks", "en",
      { chapterSummaries: "The committed summary keeps the prior condition." },
    )).resolves.toMatchObject({
      passed: false,
      repairRequired: false,
      disposition: "CONTENT_REPAIR_REQUIRED",
      proseAuthorityEvidence: {
        status: "PROVEN",
        currentProse: ["The current candidate keeps the new condition."],
        committedAuthority: ["The committed summary keeps the prior condition."],
      },
    });
  });

  it("classifies the Chapter006-equivalent regression fixture through the generic structured contract", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          disposition: "CONTENT_REPAIR_REQUIRED",
          warnings: [{ category: "ongoing_authority_contradiction", description: "The continuing injury side conflicts without a narrated change." }],
          proseAuthorityEvidence: {
            status: "PROVEN",
            currentProse: ["continues the injury on the LEFT"],
            committedAuthority: ["committed chapter keeps the injury on the RIGHT"],
          },
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "The candidate continues the injury on the LEFT without a side-change event.",
      6,
      "The committed chapter keeps the injury on the RIGHT.",
      "The settlement projects LEFT.",
      "old hooks",
      "new hooks",
      "en",
      { chapterSummaries: "The committed chapter keeps the injury on the RIGHT." },
    )).resolves.toMatchObject({ disposition: "CONTENT_REPAIR_REQUIRED" });
  });

  it.each([
    ["missing current prose evidence", { status: "PROVEN", currentProse: [], committedAuthority: ["old"] }],
    ["missing committed authority evidence", { status: "PROVEN", currentProse: ["candidate"], committedAuthority: [] }],
    ["ambiguous evidence", { status: "AMBIGUOUS", currentProse: ["candidate"], committedAuthority: ["old"] }],
  ])("fails closed for a content route with %s", async (_label, proseAuthorityEvidence) => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          disposition: "CONTENT_REPAIR_REQUIRED",
          warnings: [{ category: "authority", description: "unprovable" }],
          proseAuthorityEvidence,
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .resolves.toMatchObject({
        passed: false,
        repairRequired: false,
        disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      });
  });

  it.each([
    ["current quote is absent from candidate", ["invented candidate quote"], ["old"]],
    ["authority quote is absent from committed surfaces", ["candidate"], ["invented authority quote"]],
    ["the same quote is claimed on both conflicting surfaces", ["shared fact"], ["shared fact"]],
  ])("fails closed when PROVEN evidence is host-unprovable because %s", async (_label, currentProse, committedAuthority) => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          disposition: "CONTENT_REPAIR_REQUIRED",
          warnings: [{ category: "authority", description: "claimed contradiction" }],
          proseAuthorityEvidence: { status: "PROVEN", currentProse, committedAuthority },
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "candidate shared fact", 9, "old shared fact", "new", "old hooks", "new hooks", "en",
    )).resolves.toMatchObject({
      passed: false,
      repairRequired: false,
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      proseAuthorityEvidence: { status: "AMBIGUOUS" },
    });
  });

  it("keeps mixed content and state findings on the content-first route", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          disposition: "CONTENT_REPAIR_REQUIRED",
          stateRepairRequired: true,
          warnings: [
            { category: "ongoing_authority_contradiction", description: "candidate conflicts with committed state" },
            { category: "missing_state_update", description: "ledger omission" },
          ],
          proseAuthorityEvidence: {
            status: "PROVEN",
            currentProse: ["candidate"],
            committedAuthority: ["old"],
          },
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .resolves.toMatchObject({
        disposition: "CONTENT_REPAIR_REQUIRED",
        stateRepairRequired: true,
      });
  });

  it("does not classify an explicitly narrated authority change as a prose contradiction", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ disposition: "PASS", warnings: [] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "The chapter explicitly narrates the controlled change.", 9,
      "prior state", "changed state", "old hooks", "new hooks", "en",
    )).resolves.toMatchObject({ passed: true, disposition: "PASS" });
  });

  it("rejects legacy unstructured non-PASS verdicts", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: "FAIL\n[contradiction] prose conflicts", usage: ZERO_USAGE });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .rejects.toThrow("structured evidence");
  });

  it("rejects legacy structured JSON non-PASS without an explicit disposition", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ passed: false, repairRequired: true, warnings: [{ category: "legacy", description: "repair" }] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .rejects.toThrow("invalid response");
  });

  it.each([
    ["PASS plus repairRequired", { disposition: "PASS", repairRequired: true, warnings: [] }],
    ["PASS plus stateRepairRequired", { disposition: "PASS", stateRepairRequired: true, warnings: [] }],
    ["state repair plus passed", { disposition: "STATE_REPAIR_REQUIRED", passed: true, warnings: [] }],
    ["non-repairable plus stateRepairRequired", { disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED", stateRepairRequired: true, warnings: [] }],
  ])("rejects contradictory structured flags: %s", async (_label, verdict) => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: JSON.stringify(verdict), usage: ZERO_USAGE });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .rejects.toThrow("invalid response");
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

  it("gives committed continuing truth precedence unless the candidate explicitly narrates a transition", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 8192, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chat = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate(
      "The candidate silently places the continuing injury on the other side.", 8,
      "Committed continuing truth: injury remains on the original side.",
      "New projection silently changes the side.",
      "old hooks", "new hooks", "en",
      { chapterSummaries: "The prior committed chapter keeps the injury on the original side." },
    );

    const messages = chat.mock.calls[0]?.[0] as ReadonlyArray<{ role: string; content: string }>;
    const prompt = messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("Committed continuing truth controls by default");
    expect(prompt).toContain("only when the current candidate explicitly narrates the transition");
    expect(prompt).toContain("A silent contradiction does not override committed truth");
    expect(prompt).not.toContain("Authority priority: current chapter text > runtime truth files/current summaries");
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
