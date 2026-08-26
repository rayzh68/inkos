import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChapterReviewActions } from "./ChapterReader.js";
import type { TFunction } from "../hooks/use-i18n.js";

const labels: Record<string, string> = {
  "reader.aiReviewResolve": "AI Review & Resolve",
  "reader.reviewing": "AI Reviewing...",
  "reader.manualApproveOverride": "Manual approve override",
  "reader.manualApproveHint": "Manual status override only; does not run AI review",
  "reader.formalRecoveryRequired": "Formal offline recovery evidence owns this chapter. Use Resume in Autonomous Production.",
  "reader.reviewResolved": "Review resolved",
};
const t = ((key: string) => labels[key] ?? key) as TFunction;

describe("ChapterReader review actions", () => {
  it("makes AI Review & Resolve primary and visibly demotes manual approval", () => {
    const html = renderToStaticMarkup(createElement(ChapterReviewActions, {
      status: "drafted",
      formalOfflineRecoveryRequired: false,
      reviewing: false,
      onReview: () => undefined,
      onManualApprove: () => undefined,
      t,
    }));
    expect(html).toContain("AI Review &amp; Resolve");
    expect(html).toContain("bg-primary text-primary-foreground");
    expect(html).toContain("Manual approve override");
    expect(html).toContain("Manual status override only; does not run AI review");
  });

  it("removes ordinary review controls when formal offline recovery owns the chapter", () => {
    const html = renderToStaticMarkup(createElement(ChapterReviewActions, {
      status: "audit-failed",
      formalOfflineRecoveryRequired: true,
      reviewing: false,
      onReview: () => undefined,
      onManualApprove: () => undefined,
      t,
    }));
    expect(html).toContain("Formal offline recovery evidence owns this chapter");
    expect(html).not.toContain("AI Review &amp; Resolve");
    expect(html).not.toContain("Manual approve override");
  });
});
