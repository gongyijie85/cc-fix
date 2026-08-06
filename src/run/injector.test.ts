import { describe, it, expect } from "vitest";
import { buildEnvVars } from "./injector.js";
import type { TargetRegion } from "../detection/types.js";

describe("buildEnvVars", () => {
  it("builds correct env vars for US target", () => {
    const target: TargetRegion = {
      code: "us",
      name: "United States",
      timezone: "America/New_York",
      lang: "en_US.UTF-8",
      lcAll: "en_US.UTF-8",
    };

    const envVars = buildEnvVars(target);
    expect(envVars.TZ).toBe("America/New_York");
    expect(envVars.LANG).toBe("en_US.UTF-8");
    expect(envVars.LC_ALL).toBe("en_US.UTF-8");
  });

  it("builds correct env vars for JP target", () => {
    const target: TargetRegion = {
      code: "jp",
      name: "Japan",
      timezone: "Asia/Tokyo",
      lang: "ja_JP.UTF-8",
      lcAll: "ja_JP.UTF-8",
    };

    const envVars = buildEnvVars(target);
    expect(envVars.TZ).toBe("Asia/Tokyo");
    expect(envVars.LANG).toBe("ja_JP.UTF-8");
  });
});
