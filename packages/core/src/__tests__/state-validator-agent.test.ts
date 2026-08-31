import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { StateValidatorAgent } from "../agents/state-validator.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function candidateEvidence(
  content: string,
  assertions: ReadonlyArray<{
    kind: "CANDIDATE_ASSERTION" | "EXPLICIT_TRANSITION";
    recordId: string;
    factKey: string;
    value: string;
    quote: string;
    startUtf16?: number;
    endUtf16?: number;
    fromValue?: string;
  }>,
) {
  const candidateSha256 = createHash("sha256").update(content).digest("hex");
  const bound = assertions.map((assertion) => {
    const startUtf16 = assertion.startUtf16 ?? content.indexOf(assertion.quote);
    const endUtf16 = assertion.endUtf16 ?? startUtf16 + assertion.quote.length;
    const identity = [
      assertion.kind,
      candidateSha256,
      assertion.recordId,
      assertion.factKey,
      String(startUtf16),
      String(endUtf16),
      assertion.value.trim().replace(/\s+/gu, " ").toLocaleLowerCase(),
      (assertion.fromValue ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase(),
    ].join("\0");
    return {
      ...assertion,
      startUtf16,
      endUtf16,
      candidateSha256,
      assertionId: createHash("sha256").update(identity).digest("hex"),
    };
  });
  return { candidateSha256, assertions: bound, issues: [] as string[] };
}

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
          "{\"findings\":[]}",
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
      findings: [],
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
          findings: [{
            kind: "STATE_PROJECTION_DEFECT",
            findingId: "missing-location-update",
            description: "角色已到码头，但状态卡仍在车站",
          }],
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
      findings: [{
        kind: "STATE_PROJECTION_DEFECT",
        findingId: "missing-location-update",
        description: "角色已到码头，但状态卡仍在车站",
      }],
      warnings: [{
        category: "STATE_PROJECTION_DEFECT",
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
          findings: [{
            kind: "STATE_PROJECTION_DEFECT",
            findingId: "missing-hook-update",
            description: "The chapter advances H1, but every truth surface is unchanged.",
          }],
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
      .mockResolvedValue({ content: JSON.stringify({ findings: [] }), usage: ZERO_USAGE });

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
    const content = "The current candidate keeps the new condition.";
    const evidence = candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::protagonist state",
      factKey: "state:protagonist::protagonist state", value: "new condition", quote: content,
    }]);
    const assertion = evidence.assertions[0]!;
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "condition-conflict",
            description: "The candidate contradicts committed continuity.",
            candidateAssertionId: assertion.assertionId,
            committedRecordId: assertion.recordId,
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 12,
      "| Field | Value |\n| --- | --- |\n| Protagonist State | prior condition |",
      "| Field | Value |\n| --- | --- |\n| Protagonist State | new condition |",
      "old hooks", "new hooks", "en",
      { chapterSummaries: "The committed summary keeps the prior condition." },
      undefined, undefined, evidence,
    )).resolves.toMatchObject({
      passed: false,
      repairRequired: false,
      disposition: "CONTENT_REPAIR_REQUIRED",
      proseAuthorityEvidence: {
        status: "PROVEN",
        currentProse: ["The current candidate keeps the new condition."],
        committedAuthority: ["prior condition"],
      },
      findings: [expect.objectContaining({
        kind: "PROSE_AUTHORITY_CONTRADICTION",
        findingId: "condition-conflict",
      })],
    });
  });

  it("fails closed when two unrelated real quotes are presented as one content contradiction", async () => {
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "unrelated-quotes",
            description: "Claimed location conflict.",
            factKey: "state:protagonist::current location",
            relation: "CONFLICTING_VALUES",
            candidate: {
              subject: "protagonist", predicate: "Current Location", value: "Harbor",
              quote: "Mara carries a lantern.",
            },
            committed: {
              recordId: "state:protagonist::current location", value: "Gate", quote: "Gate",
            },
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "Mara carries a lantern. A sailor points toward Harbor. The gate remains closed.", 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Harbor |",
      "# Pending Hooks", "# Pending Hooks", "en",
    )).resolves.toMatchObject({
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      findings: [expect.objectContaining({ kind: "AMBIGUOUS", findingId: "unrelated-quotes" })],
    });
  });

  it("does not let a map titled Harbor become a protagonist-location fact without analyzer evidence", async () => {
    const content = "The map titled Harbor hung beside the protagonist at dawn.";
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model", projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ findings: [{
          kind: "PROSE_AUTHORITY_CONTRADICTION",
          findingId: "invented-location",
          description: "Claims Harbor is the protagonist location.",
          candidateAssertionId: "invented-assertion",
          committedRecordId: "state:protagonist::current location",
          factKey: "state:protagonist::current location",
          relation: "CONFLICTING_VALUES",
          candidate: {
            subject: "protagonist", predicate: "Current Location", value: "Harbor", quote: "map titled Harbor",
          },
          committed: {
            recordId: "state:protagonist::current location", value: "Gate", quote: "Gate",
          },
        }] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Harbor |",
      "# Pending Hooks", "# Pending Hooks", "en", undefined, undefined, undefined,
      candidateEvidence(content, []),
    )).resolves.toMatchObject({
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      findings: [expect.objectContaining({ kind: "AMBIGUOUS", findingId: "invented-location" })],
    });
  });

  it("lets a host-bound explicit transition dominate a validator contradiction label", async () => {
    const content = "After crossing the bridge, the protagonist moved from Gate to Harbor.";
    const quote = content;
    const evidence = candidateEvidence(content, [{
      kind: "EXPLICIT_TRANSITION",
      recordId: "state:protagonist::current location",
      factKey: "state:protagonist::current location",
      value: "Harbor",
      fromValue: "Gate",
      quote,
    }]);
    const assertion = evidence.assertions[0]!;
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model", projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ findings: [{
          kind: "PROSE_AUTHORITY_CONTRADICTION",
          findingId: "mislabelled-transition",
          description: "Validator incorrectly labels the narrated move as a contradiction.",
          candidateAssertionId: assertion.assertionId,
          committedRecordId: assertion.recordId,
          factKey: assertion.factKey,
          relation: "CONFLICTING_VALUES",
          candidate: { subject: "protagonist", predicate: "Current Location", value: "Harbor", quote },
          committed: { recordId: assertion.recordId, value: "Gate", quote: "Gate" },
        }] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "# Pending Hooks", "# Pending Hooks", "en", undefined, undefined, undefined, evidence,
    )).resolves.toMatchObject({
      disposition: "STATE_REPAIR_REQUIRED",
      findings: [expect.objectContaining({ kind: "STATE_PROJECTION_DEFECT", findingId: "mislabelled-transition" })],
    });
  });

  it.each([
    ["duplicate assertion", (content: string) => {
      const evidence = candidateEvidence(content, [{
        kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location",
        factKey: "state:protagonist::current location", value: "Harbor", quote: content,
      }]);
      return { ...evidence, assertions: [evidence.assertions[0]!, evidence.assertions[0]!] };
    }],
    ["conflicting assertions", (content: string) => {
      const evidence = candidateEvidence(content, [
        { kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location", factKey: "state:protagonist::current location", value: "Harbor", quote: content },
        { kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location", factKey: "state:protagonist::current location", value: "Dock", quote: content },
      ]);
      return evidence;
    }],
    ["wrong fact key", (content: string) => candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location",
      factKey: "state:protagonist::current goal", value: "Harbor", quote: content,
    }])],
    ["wrong record", (content: string) => candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current goal",
      factKey: "state:protagonist::current goal", value: "Harbor", quote: content,
    }])],
    ["wrong span", (content: string) => candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location",
      factKey: "state:protagonist::current location", value: "Harbor", quote: content,
      startUtf16: 1, endUtf16: content.length,
    }])],
    ["wrong candidate SHA", (content: string) => {
      const evidence = candidateEvidence(content, [{
        kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location",
        factKey: "state:protagonist::current location", value: "Harbor", quote: content,
      }]);
      return {
        ...evidence,
        candidateSha256: "0".repeat(64),
        assertions: evidence.assertions.map((assertion) => ({ ...assertion, candidateSha256: "0".repeat(64) })),
      };
    }],
  ])("fails closed for host-unprovable analyzer evidence: %s", async (_label, buildEvidence) => {
    const content = "The protagonist remains at Harbor while Dock appears on a map.";
    const evidence = buildEvidence(content);
    const referenced = evidence.assertions[0]!;
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model", projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ findings: [{
          kind: "PROSE_AUTHORITY_CONTRADICTION",
          findingId: `invalid-${_label}`,
          description: "Invalid candidate evidence must not authorize repair.",
          candidateAssertionId: referenced.assertionId,
          committedRecordId: "state:protagonist::current location",
          factKey: "state:protagonist::current location",
          relation: "CONFLICTING_VALUES",
          candidate: { subject: "protagonist", predicate: "Current Location", value: "Harbor", quote: content },
          committed: { recordId: "state:protagonist::current location", value: "Gate", quote: "Gate" },
        }] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Harbor |",
      "# Pending Hooks", "# Pending Hooks", "en", undefined, undefined, undefined, evidence,
    )).resolves.toMatchObject({
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      findings: expect.arrayContaining([expect.objectContaining({ kind: "AMBIGUOUS" })]),
    });
  });

  it("authorizes content repair from a host-bound assertion even when validator relation fields disagree", async () => {
    const content = "The protagonist remains at Harbor.";
    const evidence = candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location",
      factKey: "state:protagonist::current location", value: "Harbor", quote: content,
    }]);
    const assertion = evidence.assertions[0]!;
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model", projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ findings: [{
          kind: "PROSE_AUTHORITY_CONTRADICTION",
          findingId: "bound-location-conflict",
          description: "Restore the committed location.",
          candidateAssertionId: assertion.assertionId,
          committedRecordId: assertion.recordId,
          factKey: "state:invented::wrong",
          relation: "EXPLICIT_TRANSITION",
          transitionQuote: content,
          candidate: { subject: "invented", predicate: "wrong", value: "ignored", quote: "ignored" },
          committed: { recordId: assertion.recordId, value: "ignored", quote: "ignored" },
        }] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Harbor |",
      "# Pending Hooks", "# Pending Hooks", "en", undefined, undefined, undefined, evidence,
    )).resolves.toMatchObject({
      disposition: "CONTENT_REPAIR_REQUIRED",
      findings: [expect.objectContaining({
        kind: "PROSE_AUTHORITY_CONTRADICTION",
        findingId: "bound-location-conflict",
        factKey: "state:protagonist::current location",
        candidate: expect.objectContaining({ value: "Harbor", quote: content }),
      })],
    });
  });

  it("does not let a raw stale summary override the current structured runtime record", async () => {
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "stale-summary",
            description: "The summary appears to support Harbor.",
            factKey: "state:protagonist::current location",
            relation: "CONFLICTING_VALUES",
            candidate: {
              subject: "protagonist", predicate: "Current Location", value: "Harbor",
              quote: "The protagonist remains at Harbor.",
            },
            committed: {
              recordId: "summary:chapter-2:location", value: "Harbor", quote: "Harbor",
            },
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "The protagonist remains at Harbor.", 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Harbor |",
      "# Pending Hooks", "# Pending Hooks", "en",
      { chapterSummaries: "Chapter 2 once placed the protagonist at Harbor." },
    )).resolves.toMatchObject({
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      findings: [expect.objectContaining({ kind: "AMBIGUOUS", findingId: "stale-summary" })],
    });
  });

  it("authorizes content repair from a same-key conflicting current runtime record", async () => {
    const content = "The protagonist remains at Harbor.";
    const evidence = candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:protagonist::current location",
      factKey: "state:protagonist::current location", value: "Harbor", quote: content,
    }]);
    const assertion = evidence.assertions[0]!;
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "current-location-conflict",
            description: "Restore the continuing location.",
            candidateAssertionId: assertion.assertionId,
            committedRecordId: assertion.recordId,
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Harbor |",
      "# Pending Hooks", "# Pending Hooks", "en", undefined, undefined, undefined, evidence,
    )).resolves.toMatchObject({
      disposition: "CONTENT_REPAIR_REQUIRED",
      findings: [expect.objectContaining({
        kind: "PROSE_AUTHORITY_CONTRADICTION",
        findingId: "current-location-conflict",
      })],
    });
  });

  it("routes an explicitly narrated same-key transition to state repair", async () => {
    const content = "After crossing the bridge, the protagonist moved from Gate to Harbor.";
    const evidence = candidateEvidence(content, [{
      kind: "EXPLICIT_TRANSITION", recordId: "state:protagonist::current location",
      factKey: "state:protagonist::current location", value: "Harbor", fromValue: "Gate", quote: content,
    }]);
    const assertion = evidence.assertions[0]!;
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "narrated-location-transition",
            description: "The settlement must project the narrated move.",
            candidateAssertionId: assertion.assertionId,
            committedRecordId: assertion.recordId,
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 4,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "# Pending Hooks", "# Pending Hooks", "en", undefined, undefined, undefined, evidence,
    )).resolves.toMatchObject({
      disposition: "STATE_REPAIR_REQUIRED",
      findings: [expect.objectContaining({
        kind: "STATE_PROJECTION_DEFECT",
        findingId: "narrated-location-transition",
      })],
    });
  });

  it("classifies the Chapter006-equivalent regression fixture through the generic structured contract", async () => {
    const content = "The candidate continues the injury on the LEFT without a side-change event.";
    const quote = "continues the injury on the LEFT";
    const evidence = candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:current_state::current injury",
      factKey: "state:current_state::current injury", value: "LEFT", quote,
    }]);
    const assertion = evidence.assertions[0]!;
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "continuing-injury-conflict",
            description: "The continuing injury side conflicts without a narrated change.",
            candidateAssertionId: assertion.assertionId,
            committedRecordId: assertion.recordId,
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content,
      6,
      "| Field | Value |\n| --- | --- |\n| Current Injury | RIGHT |",
      "| Field | Value |\n| --- | --- |\n| Current Injury | LEFT |",
      "old hooks",
      "new hooks",
      "en",
      { chapterSummaries: "The committed chapter keeps the injury on the RIGHT." },
      undefined, undefined, evidence,
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "unprovable-authority",
            description: "unprovable",
            factKey: "state:current_state::note_1",
            relation: "CONFLICTING_VALUES",
            candidate: {
              subject: "current_state", predicate: "note_1", value: proseAuthorityEvidence.currentProse[0] ?? "",
              quote: proseAuthorityEvidence.currentProse[0] ?? "",
            },
            committed: {
              recordId: proseAuthorityEvidence.status === "AMBIGUOUS"
                ? "unprovable:record"
                : "state:current_state::note_1",
              value: proseAuthorityEvidence.committedAuthority[0] ?? "",
              quote: proseAuthorityEvidence.committedAuthority[0] ?? "",
            },
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "candidate", 9,
      "| Field | Value |\n| --- | --- |\n| note_1 | old |",
      "| Field | Value |\n| --- | --- |\n| note_1 | candidate |",
      "old hooks", "new hooks", "en",
    ))
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
          findings: [{
            kind: "PROSE_AUTHORITY_CONTRADICTION",
            findingId: "unprovable-quote",
            description: "claimed contradiction",
            factKey: "state:current_state::note_1",
            relation: "CONFLICTING_VALUES",
            candidate: {
              subject: "current_state", predicate: "note_1", value: currentProse[0] ?? "",
              quote: currentProse[0] ?? "",
            },
            committed: {
              recordId: "state:current_state::note_1", value: committedAuthority[0] ?? "",
              quote: committedAuthority[0] ?? "",
            },
          }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "candidate shared fact", 9, "old shared fact", "new", "old hooks", "new hooks", "en",
    )).resolves.toMatchObject({
      passed: false,
      repairRequired: false,
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      findings: [expect.objectContaining({ kind: "AMBIGUOUS" })],
    });
  });

  it("keeps mixed content and state findings on the content-first route", async () => {
    const content = "candidate";
    const evidence = candidateEvidence(content, [{
      kind: "CANDIDATE_ASSERTION", recordId: "state:current_state::note_1",
      factKey: "state:current_state::note_1", value: "candidate", quote: content,
    }]);
    const assertion = evidence.assertions[0]!;
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
          findings: [
            {
              kind: "PROSE_AUTHORITY_CONTRADICTION",
              findingId: "content-conflict",
              description: "candidate conflicts with committed state",
              candidateAssertionId: assertion.assertionId,
              committedRecordId: assertion.recordId,
            },
            { kind: "STATE_PROJECTION_DEFECT", findingId: "ledger-omission", description: "ledger omission" },
          ],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      content, 9,
      "| Field | Value |\n| --- | --- |\n| note_1 | old |",
      "| Field | Value |\n| --- | --- |\n| note_1 | candidate |",
      "old hooks", "new hooks", "en", undefined, undefined, undefined, evidence,
    ))
      .resolves.toMatchObject({
        disposition: "CONTENT_REPAIR_REQUIRED",
        stateRepairRequired: true,
      });
  });

  it("accepts only the exact raw legacy PASS token", async () => {
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
        content: "PASS",
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "The chapter explicitly narrates the controlled change.", 9,
      "prior state", "changed state", "old hooks", "new hooks", "en",
    )).resolves.toMatchObject({ passed: true, disposition: "PASS" });
  });

  it.each(["pass", "Pass", "pAsS"])("rejects non-exact legacy PASS casing: %s", async (rawVerdict) => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: rawVerdict, usage: ZERO_USAGE });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .rejects.toThrow("invalid response");
  });

  it("fails closed when raw exact PASS accompanies malformed host-bound candidate evidence", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await expect(agent.validate(
      "The candidate stays at Gate.", 9,
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "| Field | Value |\n| --- | --- |\n| Current Location | Gate |",
      "old hooks", "old hooks", "en", undefined, undefined, undefined,
      { candidateSha256: "0".repeat(64), assertions: [], issues: ["duplicate candidate evidence"] },
    )).resolves.toMatchObject({
      passed: false,
      disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      findings: expect.arrayContaining([expect.objectContaining({ kind: "AMBIGUOUS" })]),
    });
  });

  it("rejects JSON PASS compatibility because findings-mode requires an array", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: JSON.stringify({ disposition: "PASS", warnings: [] }), usage: ZERO_USAGE });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .rejects.toThrow("invalid response");
  });

  it("rejects malformed non-array findings instead of falling through to JSON PASS", async () => {
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
          disposition: "PASS",
          findings: { kind: "NON_REPAIRABLE", findingId: "hidden", description: "must not be discarded" },
          warnings: [],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .rejects.toThrow("invalid response");
  });

  it("fails closed when warnings-only JSON has no matching host-derived findings", async () => {
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
          findings: [],
          warnings: [{ category: "legacy", description: "candidate contradicts committed truth" }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .resolves.toMatchObject({
        passed: false,
        disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
        findings: [expect.objectContaining({ kind: "AMBIGUOUS", findingId: "warnings-compatibility-mismatch" })],
      });
  });

  it("fails closed when raw warnings do not exactly match the host-derived compatibility projection", async () => {
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
          findings: [{
            kind: "STATE_PROJECTION_DEFECT",
            findingId: "state-omission",
            description: "state projection is incomplete",
          }],
          warnings: [{ category: "STATE_PROJECTION_DEFECT", description: "different warning text" }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .resolves.toMatchObject({
        passed: false,
        disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
        findings: [
          expect.objectContaining({ kind: "STATE_PROJECTION_DEFECT", findingId: "state-omission" }),
          expect.objectContaining({ kind: "AMBIGUOUS", findingId: "warnings-compatibility-mismatch" }),
        ],
      });
  });

  it("accepts raw warnings only when they exactly match the host-derived compatibility projection", async () => {
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
          findings: [{
            kind: "STATE_PROJECTION_DEFECT",
            findingId: "state-omission",
            description: "state projection is incomplete",
          }],
          warnings: [{ category: "STATE_PROJECTION_DEFECT", description: "state projection is incomplete" }],
        }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .resolves.toMatchObject({
        disposition: "STATE_REPAIR_REQUIRED",
        findings: [expect.objectContaining({ kind: "STATE_PROJECTION_DEFECT", findingId: "state-omission" })],
      });
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

  it("fails closed when result-wide routing claims content repair without per-finding evidence", async () => {
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
        content: JSON.stringify({ disposition: "CONTENT_REPAIR_REQUIRED", findings: [] }),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate("candidate", 9, "old", "new", "old hooks", "new hooks", "en"))
      .resolves.toMatchObject({
        passed: false,
        disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
        findings: [expect.objectContaining({ kind: "AMBIGUOUS" })],
      });
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
