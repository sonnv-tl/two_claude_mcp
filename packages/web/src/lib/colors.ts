import type { Participant } from "@tcm/shared";

const ROLE_COLOR: Record<string, string> = { dev: "var(--c-dev)", qa: "var(--c-qa)", user: "var(--c-user)", hub: "var(--muted)" };
const PALETTE = ["var(--c-1)", "var(--c-2)", "var(--c-3)", "var(--c-4)"];

/** Màu theo vai trò (dev, qa, user), còn lại băm tên ra một màu cố định */
export function colorOf(name: string, participants: Participant[]) {
  const role = participants.find((p) => p.name === name)?.role?.toLowerCase() ?? "";
  if (ROLE_COLOR[name]) return ROLE_COLOR[name];
  if (ROLE_COLOR[role]) return ROLE_COLOR[role];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Chữ trên avatar: "dev" → "D", "qa-2" → "Q2" */
export function initials(name: string) {
  const parts = name.split(/[-_. ]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.charAt(0).toUpperCase();
}
