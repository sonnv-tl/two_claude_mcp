import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { EmojiIcon, rehypeEmojiIcons } from "../lib/emoji";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Khối code: nhãn ngôn ngữ + nút copy (như ChatGPT) */
function Pre({ children }: { children?: ReactNode }) {
  const [done, setDone] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const cls = (child && typeof child === "object" && "props" in child ? (child.props as { className?: string }).className : "") ?? "";
  const lang = cls.match(/language-([\w-]+)/)?.[1];
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? "code"}</span>
        <button
          className="code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
        >
          {done ? <Check className="ic xs" /> : <Copy className="ic xs" />}
          {done ? "Đã copy" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const COMPONENTS = {
  // Ảnh bằng chứng: thu nhỏ trong tin, bấm mở tab mới
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <a href={src} target="_blank" rel="noreferrer" className="shot">
      <img src={src} alt={alt ?? ""} loading="lazy" />
    </a>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: Pre,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  // rehypeEmojiIcons đổi emoji thành <i data-emoji>
  i: (props: React.HTMLAttributes<HTMLElement>) => <EmojiIcon emoji={String((props as Record<string, unknown>)["data-emoji"] ?? "")} />,
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeEmojiIcons]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
