// Đọc .team-hub.json (+ .team-hub.local.json) của repo đích, giống tcm: web mở ticket mới không cần chạy tcm.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import type { AgentLaunch } from "./terminals.js";

export interface RepoConfig {
  figma?: string;
  testAccount?: string;
  notes?: string;
  app?: { run?: string; url?: string };
  paths?: { plan?: string; testcases?: string; runs?: string };
  agents?: Record<string, AgentLaunch>;
}

function findConfigDir(start: string): string | null {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, ".team-hub.json")) || existsSync(join(d, ".team-hub.local.json"))) return d;
    const up = dirname(d);
    if (up === d || parsePath(d).root === d) return null;
    d = up;
  }
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${file} không phải JSON hợp lệ: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge((a?.[k] ?? {}) as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

/** Config của repo (tìm ngược lên thư mục cha như tcm). Không có thì {} */
export function loadRepoConfig(repoDir: string): { dir: string | null; cfg: RepoConfig } {
  const dir = findConfigDir(repoDir);
  if (!dir) return { dir: null, cfg: {} };
  return { dir, cfg: merge(readJson(join(dir, ".team-hub.json")), readJson(join(dir, ".team-hub.local.json"))) as RepoConfig };
}
