import { mkdtempSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { reportToPdf } from "./pdf";
import { UtilizationReport } from "./types";

const report: UtilizationReport = {
  window: { from: "2026-08-05T00:00:00.000Z", to: "2026-08-06T00:00:00.000Z" },
  resources: [],
  totalRevenueCents: 0,
  averageUtilization: 0,
};

/** Pretend to be pandoc: write a fake PDF wherever `-o` points. */
function fakePandoc(commands: string[]) {
  return async (command: string) => {
    commands.push(command);
    const out = /-o "([^"]+)"/.exec(command)?.[1];
    await fs.writeFile(out as string, "%PDF-fake");
  };
}

describe("reportToPdf", () => {
  it("converts the markdown export with pandoc and returns the PDF bytes", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
    const commands: string[] = [];
    const pdf = await reportToPdf(report, { workDir }, fakePandoc(commands));

    expect(pdf.toString()).toBe("%PDF-fake");
    expect(commands[0]).toContain("pandoc");
    expect(commands[0]).toContain('--metadata title="Utilization report"');
  });

  it("uses a custom title", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
    const commands: string[] = [];
    await reportToPdf(report, { workDir, title: "Q3 rooms" }, fakePandoc(commands));
    expect(commands[0]).toContain('title="Q3 rooms"');
  });

  it("cleans up intermediate files", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
    await reportToPdf(report, { workDir }, fakePandoc([]));
    expect(await fs.readdir(workDir)).toEqual([]);
  });
});
