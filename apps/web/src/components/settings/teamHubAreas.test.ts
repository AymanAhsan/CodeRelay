import { describe, expect, it } from "@effect/vitest";

import { areaRowState, setAreaSelected } from "./teamHubAreas";

describe("team hub area picker", () => {
  it("selecting a folder owns everything inside it and replaces nested picks", () => {
    const areas = setAreaSelected(
      new Set(["apps/web/src/main.ts", "apps/web/public/**", "apps/api/**"]),
      "apps/web",
      "directory",
      true,
    );
    expect([...areas].toSorted()).toEqual(["apps/api/**", "apps/web/**"]);
    expect(areaRowState(areas, "apps/web/src/main.ts", "file")).toBe("inherited");
    expect(areaRowState(areas, "apps/web", "directory")).toBe("selected");
  });

  it("marks folders that hold selected paths as partial", () => {
    const areas = new Set(["apps/web/src/main.ts", "packages/contracts/**"]);
    expect(areaRowState(areas, "apps", "directory")).toBe("partial");
    expect(areaRowState(areas, "packages", "directory")).toBe("partial");
    expect(areaRowState(areas, "apps/api", "directory")).toBe("none");
    // A sibling whose name shares a prefix is not inside the folder.
    expect(areaRowState(new Set(["apps/webhooks/**"]), "apps/web", "directory")).toBe("none");
  });

  it("clearing a row removes only that area", () => {
    const areas = setAreaSelected(
      new Set(["apps/web/**", "README.md"]),
      "README.md",
      "file",
      false,
    );
    expect([...areas]).toEqual(["apps/web/**"]);
  });
});
