import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MESSAGE_TYPES, type ChatMessage, type MessageType, type Participant } from "@tcm/shared";
import { useRoom, useRooms } from "./useRoom";

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
  const { messages, participants, conn } = useRoom(room);
  const [hidden, setHidden] = useState<Set<MessageType>>(new Set());

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
        <MessageList messages={visible} byId={byId} participants={participants} />
        <footer className="composer-placeholder muted small">
          Phase 1: chế độ xem. Ô chat cho bạn sẽ có ở Phase 2.
        </footer>
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

function MessageList({
  messages,
  byId,
  participants,
}: {
  messages: ChatMessage[];
  byId: Map<number, ChatMessage>;
  participants: Participant[];
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
