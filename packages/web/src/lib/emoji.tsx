// Emoji trong tin nhắn / trạng thái (do hub, agent viết) → icon. Emoji lạ giữ nguyên.
import type { ReactNode } from "react";
import {
  Bell,
  Bug,
  Check,
  CircleCheck,
  CircleX,
  FileText,
  Flag,
  Hourglass,
  Image,
  Inbox,
  Info,
  Lightbulb,
  Monitor,
  Moon,
  PartyPopper,
  Pin,
  Repeat,
  Rocket,
  Scale,
  Search,
  NotebookPen,
  ThumbsUp,
  Ticket,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

type Tone = "ok" | "danger" | "warn" | "info" | "muted" | undefined;

const MAP: Record<string, [LucideIcon, Tone]> = {
  "🐞": [Bug, "danger"],
  "🐛": [Bug, "danger"],
  "⚖️": [Scale, "warn"],
  "⚖": [Scale, "warn"],
  "🏁": [Flag, "ok"],
  "⚠️": [TriangleAlert, "warn"],
  "⚠": [TriangleAlert, "warn"],
  "🎫": [Ticket, "info"],
  "📄": [FileText, "info"],
  "📝": [NotebookPen, "info"],
  "🔁": [Repeat, "warn"],
  "💤": [Moon, "muted"],
  "📬": [Inbox, "info"],
  "✅": [CircleCheck, "ok"],
  "✔️": [Check, "ok"],
  "✔": [Check, "ok"],
  "✓": [Check, "ok"],
  "❌": [CircleX, "danger"],
  "✘": [X, "danger"],
  "✗": [X, "danger"],
  "🖼️": [Image, "muted"],
  "🖼": [Image, "muted"],
  "🎉": [PartyPopper, "ok"],
  "🖥️": [Monitor, undefined],
  "🖥": [Monitor, undefined],
  "💡": [Lightbulb, "warn"],
  "📌": [Pin, "danger"],
  "🚀": [Rocket, "info"],
  "👍": [ThumbsUp, "ok"],
  "🔍": [Search, undefined],
  "⏳": [Hourglass, "muted"],
  "ℹ️": [Info, "info"],
  "🔔": [Bell, "warn"],
};

const RE = new RegExp(
  `(${Object.keys(MAP)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\uFE0F?`,
  "gu",
);

export function EmojiIcon({ emoji }: { emoji: string }) {
  const hit = MAP[emoji] ?? MAP[emoji.replace(/️$/, "")];
  if (!hit) return <>{emoji}</>;
  const [Icon, tone] = hit;
  return <Icon className={`emo ${tone ? `tone-${tone}` : ""}`} aria-label={emoji} />;
}

/** Chuỗi thường có emoji → text + icon */
export function IconText({ text }: { text: string }): ReactNode {
  return text.split(RE).map((p, i) => (i % 2 ? <EmojiIcon key={i} emoji={p} /> : p));
}

/** Bỏ emoji đầu chuỗi (khi đã có icon riêng cho ngữ cảnh) */
export const stripLeadingEmoji = (text: string) => text.replace(new RegExp(`^\\s*(?:${RE.source})\\s*`, "u"), "");

// ---------- rehype plugin: emoji trong markdown → <i data-emoji> (component `i` vẽ icon) ----------

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HNode[];
  properties?: Record<string, unknown>;
}

function walk(node: HNode) {
  if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
  const out: HNode[] = [];
  for (const c of node.children) {
    if (c.type === "text" && c.value && RE.test(c.value)) {
      RE.lastIndex = 0;
      c.value.split(RE).forEach((p, i) => {
        if (i % 2) out.push({ type: "element", tagName: "i", properties: { dataEmoji: p }, children: [] });
        else if (p) out.push({ type: "text", value: p });
      });
    } else {
      walk(c);
      out.push(c);
    }
    RE.lastIndex = 0;
  }
  node.children = out;
}

export function rehypeEmojiIcons() {
  return (tree: HNode) => walk(tree);
}
