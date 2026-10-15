import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Bug, Check, Copy, CornerUpLeft, Info, Reply } from "lucide-react";
import type { ChatMessage } from "@tcm/shared";
import { Avatar } from "./ui/Avatar";
import { Markdown } from "./Markdown";
import { IconText, stripLeadingEmoji } from "../lib/emoji";
import { dayLabel, plain, sameDay, timeHM, dateTime } from "../lib/format";
import { HUMAN, TYPE_ICON, TYPE_LABEL } from "../lib/types";

export interface MessageListHandle {
  /** Cuộn tới tin (nháy viền) */
  jump: (id: number) => void;
  toBottom: () => void;
}

const GROUP_MS = 5 * 60_000;
const CALLOUT = new Set(["bug_report", "ac_deviation", "report", "question", "handoff", "test_case"]);

export const MessageList = forwardRef<
  MessageListHandle,
  {
    messages: ChatMessage[];
    byId: Map<number, ChatMessage>;
    colorOf: (name: string) => string;
    onReply: (m: ChatMessage) => void;
    onOpenBugs: () => void;
    empty: ReactNode;
    children?: ReactNode;
  }
>(function MessageList({ messages, byId, colorOf, onReply, onOpenBugs, empty, children }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(messages.length);

  const toBottom = (smooth = true) => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const jump = (id: number) => {
    const el = document.getElementById(`m${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  };
  useImperativeHandle(ref, () => ({ jump, toBottom: () => toBottom() }));

  const onScroll = () => {
    const el = box.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  };

  useLayoutEffect(() => {
    const added = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (stick.current) toBottom(false);
    else if (added > 0) setUnseen((n) => n + added);
  }, [messages]);

  // Ảnh tải xong làm cao thêm: vẫn bám đáy nếu đang ở đáy
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => stick.current && toBottom(false));
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="thread-wrap">
      <div className="thread" ref={box} onScroll={onScroll}>
        <div className="thread-inner">
          {messages.length === 0 ? empty : <Rows messages={messages} byId={byId} colorOf={colorOf} onReply={onReply} onJump={jump} onOpenBugs={onOpenBugs} />}
        </div>
      </div>
      {!atBottom && (
        <button className="to-bottom" onClick={() => toBottom()} aria-label="Cuộn xuống tin mới nhất">
          <ArrowDown className="ic" />
          {unseen > 0 && <span>{unseen} tin mới</span>}
        </button>
      )}
      {children}
    </div>
  );
});

const Rows = memo(function Rows({
  messages,
  byId,
  colorOf,
  onReply,
  onJump,
  onOpenBugs,
}: {
  messages: ChatMessage[];
  byId: Map<number, ChatMessage>;
  colorOf: (name: string) => string;
  onReply: (m: ChatMessage) => void;
  onJump: (id: number) => void;
  onOpenBugs: () => void;
}) {
  const out: ReactNode[] = [];
  let prev: ChatMessage | null = null;
  let lastAt: string | null = null;
  for (const m of messages) {
    if (!lastAt || !sameDay(lastAt, m.createdAt)) {
      out.push(
        <div key={`d${m.id}`} className="day-sep">
          <span>{dayLabel(m.createdAt)}</span>
        </div>,
      );
      prev = null;
    }
    lastAt = m.createdAt;
    if (m.type === "system") {
      out.push(
        <div key={m.id} id={`m${m.id}`} className="sys">
          <Info className="ic xs" />
          <span>
            <IconText text={m.content} />
          </span>
          <time dateTime={m.createdAt}>{timeHM(m.createdAt)}</time>
        </div>,
      );
      prev = null;
      continue;
    }
    const cont =
      !!prev &&
      prev.from === m.from &&
      prev.to === m.to &&
      !m.replyTo &&
      m.type === "chat" &&
      prev.type !== "system" &&
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_MS;
    out.push(
      <Message
        key={m.id}
        m={m}
        cont={cont}
        quoted={m.replyTo ? byId.get(m.replyTo) : undefined}
        color={colorOf(m.from)}
        onReply={onReply}
        onJump={onJump}
        onOpenBugs={onOpenBugs}
      />,
    );
    prev = m;
  }
  return <>{out}</>;
});

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn xs"
      title="Copy markdown"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="ic" /> : <Copy className="ic" />}
    </button>
  );
}

const Message = memo(function Message({
  m,
  cont,
  quoted,
  color,
  onReply,
  onJump,
  onOpenBugs,
}: {
  m: ChatMessage;
  cont: boolean;
  quoted?: ChatMessage;
  color: string;
  onReply: (m: ChatMessage) => void;
  onJump: (id: number) => void;
  onOpenBugs: () => void;
}) {
  const mine = m.from === HUMAN;
  const TypeIcon = TYPE_ICON[m.type];
  const typeBadge = m.type !== "chat" && (
    <span className={`badge type-${m.type}`}>
      <TypeIcon className="ic xs" />
      {TYPE_LABEL[m.type]}
    </span>
  );
  const quote = m.replyTo && (
    <button className="quote" onClick={() => onJump(m.replyTo!)} title={`Tới tin #${m.replyTo}`}>
      <CornerUpLeft className="ic xs" />
      <span>
        {quoted ? (
          <>
            <strong>{quoted.from}</strong> {plain(stripLeadingEmoji(quoted.content)).slice(0, 90)}
          </>
        ) : (
          `tin #${m.replyTo}`
        )}
      </span>
    </button>
  );
  const actions = (
    <div className="msg-actions">
      <CopyBtn text={m.content} />
      <button className="icon-btn xs" title="Trả lời" aria-label="Trả lời" onClick={() => onReply(m)}>
        <Reply className="ic" />
      </button>
      {m.type === "bug_report" && (
        <button className="icon-btn xs" title="Mở bảng bug" aria-label="Mở bảng bug" onClick={onOpenBugs}>
          <Bug className="ic" />
        </button>
      )}
      <span className="msg-id" title={dateTime(m.createdAt)}>
        #{m.id} · {timeHM(m.createdAt)}
      </span>
    </div>
  );

  if (mine)
    return (
      <article id={`m${m.id}`} className="msg mine">
        {(m.to !== "@all" || m.type !== "chat") && (
          <div className="mine-meta">
            {m.to !== "@all" && <span>gửi riêng @{m.to}</span>}
            {typeBadge}
          </div>
        )}
        <div className={`bubble ${m.type !== "chat" ? `bubble-${m.type}` : ""}`}>
          {quote}
          <Markdown>{m.content}</Markdown>
        </div>
        {actions}
      </article>
    );

  return (
    <article id={`m${m.id}`} className={`msg agent ${cont ? "cont" : ""} ${CALLOUT.has(m.type) ? `callout-msg type-${m.type}` : ""}`}>
      <div className="msg-gutter">{!cont && <Avatar name={m.from} color={color} />}</div>
      <div className="msg-main">
        {!cont && (
          <div className="msg-head">
            <strong style={{ color }}>{m.from}</strong>
            {m.to !== "@all" && <span className="muted">→ {m.to}</span>}
            {typeBadge}
            <time className="muted" dateTime={m.createdAt} title={dateTime(m.createdAt)}>
              {timeHM(m.createdAt)}
            </time>
          </div>
        )}
        {quote}
        <div className="msg-content">
          <Markdown>{m.content}</Markdown>
        </div>
        {actions}
      </div>
    </article>
  );
});
