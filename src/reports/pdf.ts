import { exec } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { reportToMarkdown } from "./markdown";
import { UtilizationReport } from "./types";

/** Runs a shell command; injectable so tests do not need pandoc installed. */
export type CommandRunner = (command: string) => Promise<unknown>;

const execAsync: CommandRunner = promisify(exec);

export interface PdfOptions {
  /** Title printed on the first page. Defaults to "Utilization report". */
  title?: string;
  /** Directory for intermediate files. Defaults to the OS temp directory. */
  workDir?: string;
}

const DEFAULT_TITLE = "Utilization report";

/**
 * Render a utilization report as a PDF. The Markdown export is handed to
 * pandoc, which must be on PATH in production (see README).
 */
export async function reportToPdf(
  report: UtilizationReport,
  options: PdfOptions = {},
  run: CommandRunner = execAsync,
): Promise<Buffer> {
  const title = options.title?.trim() || DEFAULT_TITLE;
  const workDir = options.workDir ?? os.tmpdir();
  const base = path.join(workDir, `utilization-${report.window.from.slice(0, 10)}`);
  const mdPath = `${base}.md`;
  const pdfPath = `${base}.pdf`;

  await fs.writeFile(mdPath, reportToMarkdown(report), "utf8");
  try {
    await run(`pandoc "${mdPath}" -o "${pdfPath}" --metadata title="${title}"`);
    return await fs.readFile(pdfPath);
  } finally {
    await Promise.allSettled([fs.unlink(mdPath), fs.unlink(pdfPath)]);
  }
}
