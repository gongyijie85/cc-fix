import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** CI 允许跳过本地截图基线，其他 GUI 用例必须执行。 */
export default class CiSkipReporter implements Reporter {
  private unexpectedSkips: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "skipped" && !test.tags.includes("@visual-baseline")) {
      this.unexpectedSkips.push(test.title);
    }
  }

  async onEnd(result: FullResult) {
    if (result.status === "passed" && this.unexpectedSkips.length > 0) {
      console.error("CI 意外跳过了以下 GUI 用例：\n" + this.unexpectedSkips.join("\n"));
      return { status: "failed" as const };
    }
  }
}
