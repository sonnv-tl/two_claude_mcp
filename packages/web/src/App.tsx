import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BROADCAST, MESSAGE_TYPES, type ChatMessage, type MessageType, type Participant } from "@tcm/shared";
import { useRoom, useRooms, type OutgoingMessage } from "./useRoom";

const HUMAN = "user";
const USER_TYPES: MessageType[] = ["chat", "question", "handoff"];

const TYPE_LABEL: Record<MessageType, string> = {
  chat: "chat",
  question: "câu hỏi",
  ac_deviation: "lệch AC",
  test_case: "test case",
  bug_report: "bug",
  handoff: "bàn giao",
  system: "hệ thống",
};

const ROLE_COLOR: Record<string, string> = { dev: "var(--c-dev)", qa: "var(--c-qa)", user: "var(--c-user)" };
const PALETTE = ["var(--c-1)", "var(--c-2)", "var(--c-3)", "var(--c-4)"];

function colorOf(name: string, participants: Participant[]) {
  const role = participants.find((p) => p.name === name)?.role?.toLowerCase() ?? "";
  if (ROLE_COLOR[name]) return ROLE_COLOR[name];
  if (ROLE_COLOR[role]) return ROLE_COLOR[role];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function useHashRoom(): [string | null, (r: string) => void] {
  const read = () => decodeURIComponent(location.hash.replace(/^#\/?/, "")) || null;
  const [room, setRoom] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setRoom(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [room, (r) => (location.hash = `/${encodeURIComponent(r)}`)];
}

export function App() {
  const rooms = useRooms();
  const [room, setRoom] = useHashRoom();
  const { messages, participants, conn, send } = useRoom(room);
  const [hidden, setHidden] = useState<Set<MessageType>>(new Set());
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);

  useEffect(() => setReplyTo(null), [room]);

  // Mặc định mở phòng hoạt động gần nhất
  useEffect(() => {
    if (!room && rooms.length) setRoom(rooms[0].name);
  }, [room, rooms]);

  const visible = useMemo(() => messages.filter((m) => !hidden.has(m.type)), [messages, hidden]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const toggle = (t: MessageType) =>
    setHidden((s) => {
      const n = new Set(s);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });

  return (
    <div className="layout">
      <aside className="rooms">
        <h1>Team Hub</h1>
        <div className="section-title">Phòng</div>
        {rooms.length === 0 && <div className="muted small">Chưa có phòng. Khởi động một Claude session có bridge để tạo phòng.</div>}
        {rooms.map((r) => (
          <button key={r.name} className={`room ${r.name === room ? "active" : ""}`} onClick={() => setRoom(r.name)}>
            <span className="room-name">#{r.name}</span>
            <span className="muted small">{r.messageCount}</span>
          </button>
        ))}
      </aside>

      <main className="timeline">
        <header className="timeline-head">
          <div>
            <strong>{room ? `#${room}` : "—"}</strong>
            <span className={`conn conn-${conn}`}>{conn === "open" ? "live" : conn === "connecting" ? "đang kết nối…" : "mất kết nối"}</span>
          </div>
          <div className="filters">
            {MESSAGE_TYPES.map((t) => (
              <button key={t} className={`chip type-${t} ${hidden.has(t) ? "off" : ""}`} onClick={() => toggle(t)}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </header>
        <MessageList messages={visible} byId={byId} participants={participants} onReply={setReplyTo} />
        <Composer
          key={room ?? ""}
          participants={participants}
          disabled={!room || conn !== "open"}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={async (m) => {
            await send(m);
            setReplyTo(null);
          }}
        />
      </main>

      <aside className="people">
        <div className="section-title">Thành viên</div>
        {participants.map((p) => (
          <div key={p.name} className="person">
            <span className={`dot ${p.online ? "on" : ""}`} />
            <div>
              <div>
                <strong style={{ color: colorOf(p.name, participants) }}>{p.name}</strong>{" "}
                <span className="muted small">{p.role || p.kind}</span>
              </div>
              {p.status && <div className="small status">{p.status}</div>}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

function Composer({
  participants,
  disabled,
  replyTo,
  onCancelReply,
  onSend,
}: {
  participants: Participant[];
  disabled: boolean;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  onSend: (m: OutgoingMessage) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [to, setTo] = useState(BROADCAST);
  const [type, setType] = useState<MessageType>("chat");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recipients = participants.filter((p) => p.name !== HUMAN);

  // Bấm "trả lời" một tin → gửi lại cho người đó
  useEffect(() => {
    if (replyTo && replyTo.from !== HUMAN && replyTo.from !== "hub") setTo(replyTo.from);
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  const submit = async () => {
    let content = text.trim();
    let target = to;
    // "@qa nội dung" ở đầu tin → đổi người nhận
    const m = content.match(/^@([\w.-]+)\s+([\s\S]+)$/);
    if (m && (m[1] === "all" || recipients.some((p) => p.name === m[1]))) {
      target = m[1] === "all" ? BROADCAST : m[1];
      content = m[2].trim();
    }
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend({ to: target, content, type, replyTo: replyTo?.id ?? null });
      setText("");
      setType("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <footer className="composer">
      {replyTo && (
        <div className="composer-reply small">
          ↳ trả lời #{replyTo.id} của <strong>{replyTo.from}</strong>: {replyTo.content.slice(0, 100)}
          <button className="link" onClick={onCancelReply}>huỷ</button>
        </div>
      )}
      {error && <div className="composer-error small">{error}</div>}
      <div className="composer-row">
        <select value={to} onChange={(e) => setTo(e.target.value)} disabled={disabled} title="Người nhận">
          <option value={BROADCAST}>@all (cả phòng)</option>
          {recipients.map((p) => (
            <option key={p.name} value={p.name}>
              @{p.name}{p.online ? "" : " (offline)"}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as MessageType)} disabled={disabled} title="Loại tin">
          {USER_TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
        <textarea
          ref={inputRef}
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={disabled ? "Chưa kết nối…" : "Nhắn cho team… (Enter gửi · Shift+Enter xuống dòng · @qa để gửi riêng)"}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="send" onClick={() => void submit()} disabled={disabled || busy || !text.trim()}>
          Gửi
        </button>
      </div>
    </footer>
  );
}

function MessageList({
  messages,
  byId,
  participants,
  onReply,
}: {
  messages: ChatMessage[];
  byId: Map<number, ChatMessage>;
  participants: Participant[];
  onReply: (m: ChatMessage) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);

  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      {messages.length === 0 && <div className="empty muted">Chưa có tin nhắn.</div>}
      {messages.map((m) =>
        m.type === "system" ? (
          <div key={m.id} className="system small muted">
            {m.content} · {new Date(m.createdAt).toLocaleTimeString("vi-VN", { hour12: false })}
          </div>
        ) : (
          <article key={m.id} id={`m${m.id}`} className="msg" style={{ borderLeftColor: colorOf(m.from, participants) }}>
            <div className="msg-head">
              <strong style={{ color: colorOf(m.from, participants) }}>{m.from}</strong>
              <span className="muted">→ {m.to}</span>
              {m.type !== "chat" && <span className={`chip type-${m.type}`}>{TYPE_LABEL[m.type]}</span>}
              <span className="muted small">
                #{m.id} · {new Date(m.createdAt).toLocaleTimeString("vi-VN", { hour12: false })}
              </span>
              <button className="link small reply-btn" onClick={() => onReply(m)}>trả lời</button>
            </div>
            {m.replyTo && (
              <a className="reply small muted" href={`#m${m.replyTo}`} onClick={(e) => {
                e.preventDefault();
                document.getElementById(`m${m.replyTo}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}>
                ↳ trả lời #{m.replyTo}
                {byId.get(m.replyTo) && `: ${byId.get(m.replyTo)!.content.slice(0, 80)}`}
              </a>
            )}
            <div className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
            </div>
          </article>
        ),
      )}
    </div>
  );
}
