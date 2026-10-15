import { Maximize2, Minimize2, SquareTerminal, X } from "lucide-react";
import type { TermInfo } from "@tcm/shared";
import type { TermSub } from "../useRoom";
import { TerminalPanel } from "./TerminalPanel";

/**
 * Terminal agent chạy ngầm, gắn bên phải cạnh khung chat (vẫn chat được khi đang xem).
 * Đóng chỉ ẩn đi, session vẫn chạy trên hub. Không đóng bằng Esc: Esc cần cho Claude (dừng lượt).
 */
export function TerminalDock({
  room,
  terms,
  open,
  toggle,
  onClose,
  maximized,
  setMaximized,
  colorOf,
  openTerm,
  raw,
  onStart,
  onStop,
  connected,
}: {
  room: string;
  terms: TermInfo[];
  open: string[];
  toggle: (name: string, want?: boolean) => void;
  onClose: () => void;
  maximized: boolean;
  setMaximized: (v: boolean) => void;
  colorOf: (name: string) => string;
  openTerm: (name: string, sub: TermSub) => () => void;
  raw: (op: Record<string, unknown>) => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  connected: boolean;
}) {
  const shown = open.filter((n) => terms.some((t) => t.name === n));
  return (
    <aside className="term-dock" aria-label="Terminal agent">
      <header className="panel-head">
        <SquareTerminal className="ic" />
        <strong className="panel-title">Terminal</strong>
        <div className="term-tabs">
          {terms.map((t) => (
            <button
              key={t.name}
              className={`chip ${open.includes(t.name) ? "on" : ""}`}
              title={open.includes(t.name) ? `Ẩn ${t.name}` : `Xem thêm ${t.name}`}
              onClick={() => toggle(t.name)}
            >
              <span className="term-dot" style={{ background: t.running ? colorOf(t.name) : "var(--muted)" }} />
              {t.name}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={() => setMaximized(!maximized)}
          title={maximized ? "Thu nhỏ (hiện lại khung chat)" : "Phóng to"}
          aria-label={maximized ? "Thu nhỏ" : "Phóng to"}
        >
          {maximized ? <Minimize2 className="ic" /> : <Maximize2 className="ic" />}
        </button>
        <button className="icon-btn" onClick={onClose} title="Đóng (session vẫn chạy ngầm)" aria-label="Đóng terminal">
          <X className="ic" />
        </button>
      </header>
      <div className="term-stack">
        {!connected && <div className="panel-empty">Mất kết nối hub, đang thử lại…</div>}
        {connected && shown.length === 0 && (
          <div className="panel-empty">
            {terms.length ? "Chọn agent ở trên để xem terminal." : "Phòng chưa có agent chạy ngầm trên hub (mở bằng Phòng mới hoặc tcm start)."}
          </div>
        )}
        {connected &&
          shown.map((n, i) => (
            <TerminalPanel
              key={`${room}/${n}`}
              name={n}
              info={terms.find((t) => t.name === n)}
              color={colorOf(n)}
              openTerm={openTerm}
              raw={raw}
              onStart={() => onStart(n)}
              onStop={() => onStop(n)}
              onClose={() => toggle(n, false)}
              autoFocus={i === shown.length - 1}
            />
          ))}
      </div>
    </aside>
  );
}
