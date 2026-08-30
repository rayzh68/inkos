import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSettings } from "./ProjectSettings.js";

describe("ProjectSettings production model controls", () => {
  it("renders exactly three product roles and no internal production capability controls", () => {
    const html = renderToStaticMarkup(createElement(ProjectSettings, {
      nav: { toDashboard: () => undefined } as never,
      theme: "light",
      t: ((key: string) => key) as never,
    }));

    expect(html).toContain('data-testid="production-role-models"');
    expect(html).toContain('aria-label="Search or enter Production model"');
    expect(html).toContain('aria-label="Search or enter Review model"');
    expect(html).toContain('aria-label="Search or enter Reader model"');
    expect(html).toContain("VERIFIED_IN_CURRENT_CATALOG");
    expect(html).not.toContain('aria-label="Search or enter Writer model"');
    expect(html).not.toContain('aria-label="Search or enter Reviser model"');
    expect(html).not.toContain('aria-label="Search or enter Observer');
  });
});
