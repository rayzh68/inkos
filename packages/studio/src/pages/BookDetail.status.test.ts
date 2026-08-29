import { describe, expect, it } from "vitest";
import { CHAPTER_STATUS_PILL_GEOMETRY, translateChapterStatus } from "./BookDetail.js";

describe("BookDetail chapter terminal badges", () => {
  const en = ((key: string) => key === "nav.connected" ? "Connected" : key === "chapter.approved" ? "Approved" : key) as never;
  const zh = ((key: string) => key === "nav.connected" ? "已连接" : key === "chapter.approved" ? "通过" : key) as never;

  it.each([
    ["approved", "Approved", "通过"],
    ["APPROVED", "Approved", "通过"],
    ["accepted-with-findings", "Notes", "有备注"],
    ["ACCEPTED_WITH_FINDINGS", "Notes", "有备注"],
  ] as const)("maps %s to locale-exclusive compact copy", (status, expectedEn, expectedZh) => {
    expect(translateChapterStatus(status, en)).toBe(expectedEn);
    expect(translateChapterStatus(status, zh)).toBe(expectedZh);
  });

  it("keeps Approved and Notes on the same compact pill geometry", () => {
    expect(CHAPTER_STATUS_PILL_GEOMETRY).toContain("inline-flex");
    expect(CHAPTER_STATUS_PILL_GEOMETRY).toContain("px-2.5 py-1");
    expect(CHAPTER_STATUS_PILL_GEOMETRY).toContain("rounded-full");
    expect(CHAPTER_STATUS_PILL_GEOMETRY).not.toContain("w-");
    expect(CHAPTER_STATUS_PILL_GEOMETRY).not.toContain("h-");
  });
});
