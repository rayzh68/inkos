import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutonomousDashboardSummary } from "./AutonomousDashboardSummary.js";

describe("Dashboard autonomous summary", () => {
  it("renders one compact operator line without role, token, blocker, or start controls", () => {
    const html = renderToStaticMarkup(createElement(AutonomousDashboardSummary, {
      autonomous: {
        totalChapters: 156,
        nextChapter: 5,
        currentVolume: { volumeNumber: 1, startChapter: 1, endChapter: 38 },
        runtimeStatus: "BLOCKED",
        actualCostUsd: null,
        currentVolumeForecast: { lowUsd: 12, baseUsd: 15, highUsd: 18 },
      },
      onOpen: () => undefined,
    }));
    expect(html).toContain("Volume I · 001–038");
    expect(html).toContain("Next Chapter 005");
    expect(html).toContain("Error");
    expect(html).not.toContain("BLOCKED");
    expect(html).toContain("Actual Unavailable");
    expect(html).toContain("Forecast $12.00–$18.00");
    expect(html).toContain(">Open<");
    expect(html).not.toContain("Run / Resume");
    expect(html).not.toContain("Token");
    expect(html).not.toContain("Runtime blockers");
  });

  it("renders locale-exclusive Chinese copy without the raw runtime enum", () => {
    const html = renderToStaticMarkup(createElement(AutonomousDashboardSummary, {
      autonomous: {
        totalChapters: 156, nextChapter: 5,
        currentVolume: { volumeNumber: 1, startChapter: 1, endChapter: 38 },
        runtimeStatus: "PAUSED_PIPELINE_ERROR", actualCostUsd: null,
        currentVolumeForecast: { lowUsd: null, baseUsd: null, highUsd: null },
      },
      onOpen: () => undefined,
      language: "zh",
    }));
    expect(html).toContain("错误");
    expect(html).toContain("不可用");
    expect(html).toContain(">打开<");
    expect(html).not.toContain("PAUSED_PIPELINE_ERROR");
    expect(html).not.toContain("Unavailable");
  });

  it.each(["HELD_AFTER_TWO_REVISIONS", "REVIEW_DECISION_CONTRADICTORY"])("renders terminal review status %s as Error", (runtimeStatus) => {
    const html = renderToStaticMarkup(createElement(AutonomousDashboardSummary, {
      autonomous: {
        totalChapters: 156, nextChapter: 5,
        currentVolume: { volumeNumber: 1, startChapter: 1, endChapter: 38 },
        runtimeStatus, actualCostUsd: null,
        currentVolumeForecast: { lowUsd: null, baseUsd: null, highUsd: null },
      },
      onOpen: () => undefined,
    }));
    expect(html).toContain("Error");
    expect(html).not.toContain(runtimeStatus);
  });

  it.each([["en", "Paused"], ["zh", "已暂停"]] as const)("renders PAUSED_BY_USER in %s", (language, label) => {
    const html = renderToStaticMarkup(createElement(AutonomousDashboardSummary, {
      autonomous: {
        totalChapters: 156, nextChapter: 5,
        currentVolume: { volumeNumber: 1, startChapter: 1, endChapter: 38 },
        runtimeStatus: "PAUSED_BY_USER", actualCostUsd: null,
        currentVolumeForecast: { lowUsd: null, baseUsd: null, highUsd: null },
      }, onOpen: () => undefined, language,
    }));
    expect(html).toContain(label);
    expect(html).not.toContain("PAUSED_BY_USER");
  });
});
