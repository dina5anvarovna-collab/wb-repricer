import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { envPublicParseDebugEnabled, resolvePublicParseDebugDir } from "./publicBrowserRuntime.js";
import type { PublicParseBlockReason } from "./publicParseBlockReason.js";

const DEBUG_MAX_FILES = 20;

async function pruneOldDebugFiles(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const p = path.join(dir, name);
        try {
          const st = await fsp.stat(p);
          if (!st.isFile()) return null;
          return { path: p, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      }),
    )
  ).filter((x): x is { path: string; mtimeMs: number } => x != null);

  if (files.length <= DEBUG_MAX_FILES) return;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = files.slice(DEBUG_MAX_FILES);
  await Promise.allSettled(toRemove.map((f) => fsp.unlink(f.path)));
}

export async function savePublicParseDebugArtifacts(params: {
  page: Page;
  nmId: number;
  reason: PublicParseBlockReason;
  pageTitle: string | null;
  bodySnippet: string;
  attemptIndex?: number;
}): Promise<{ paths: string[] }> {
  if (!envPublicParseDebugEnabled()) {
    return { paths: [] };
  }

  const dir = resolvePublicParseDebugDir();
  await fsp.mkdir(dir, { recursive: true });
  await pruneOldDebugFiles(dir);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `nm${params.nmId}-${params.reason}-${ts}${params.attemptIndex != null ? `-a${params.attemptIndex}` : ""}`;
  const paths: string[] = [];

  const metaPath = path.join(dir, `${base}.meta.json`);
  const txtPath = path.join(dir, `${base}.snippet.txt`);
  const pngPath = path.join(dir, `${base}.png`);

  await fsp.writeFile(
    metaPath,
    JSON.stringify(
      {
        nmId: params.nmId,
        reason: params.reason,
        url: params.page.url(),
        title: params.pageTitle,
        attemptIndex: params.attemptIndex ?? null,
        ts: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  paths.push(metaPath);

  await fsp.writeFile(txtPath, params.bodySnippet.slice(0, 4096), "utf8");
  paths.push(txtPath);

  try {
    await params.page.screenshot({ path: pngPath, fullPage: false });
    paths.push(pngPath);
  } catch {
    /* ignore */
  }

  await pruneOldDebugFiles(dir);
  return { paths };
}
