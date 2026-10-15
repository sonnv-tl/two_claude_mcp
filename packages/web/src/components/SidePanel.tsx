import { Bug as BugIcon, SquareTerminal, Users, X } from "lucide-react";
import type { Board, BugStatus, Participant, TermInfo } from "@tcm/shared";
import { Avatar } from "./ui/Avatar";
import { BugPanel, OPEN_BUG } from "./BugPanel";
import { IconText, stripLeadingEmoji } from "../lib/emoji";

export type InfoTab = "people" | "bugs";

/** Ngăn kéo bên phải: thành viên / bug (đóng sẵn, giống canvas của ChatGPT) */
export function SidePanel({
  tab,
  setTab,
  onClose,
  board,
  participants,
  terms,
  colorOf,
  openTerms,
  onToggleTerm,
  onJump,
  onUpdateBug,
  disabled,
}: {
  tab: InfoTab;
  setTab: (t: InfoTab) => void;
  onClose: () => void;
  board: Board;
  participants: Participant[];
  terms: TermInfo[];
  colorOf: (name: string) => string;
  openTerms: string[];
  onToggleTerm: (name: string) => void;
  onJump: (msgId: number) => void;
  onUpdateBug: (code: string, status: BugStatus, note?: string) => Promise<unknown>;
  disabled: boolean;
}) {
  const openBugs = board.bugs.filter((b) => OPEN_BUG.includes(b.status)).length;
  const needUser = board.bugs.some((b) => b.status === "need_user");
  const termOf = (n: string) => terms.find((t) => t.name === n);
  const notJoined = terms.filter((t) => !participants.some((p) => p.name === t.name));

  return (
    <aside className="side-panel" aria-label="Thông tin phòng">
      <header className="panel-head">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "people"} className={tab === "people" ? "on" : ""} onClick={() => setTab("people")}>
            <Users className="ic" /> Thành viên
          </button>
          <button role="tab" aria-selected={tab === "bugs"} className={tab === "bugs" ? "on" : ""} onClick={() => setTab("bugs")}>
            <BugIcon className="ic" /> Bug
            {board.bugs.length > 0 && (
              <span className="count">
                {openBugs}/{board.bugs.length}
              </span>
            )}
            {(needUser || board.warning) && <span className="badge-dot" />}
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Đóng panel" title="Đóng">
          <X className="ic" />
        </button>
      </header>
      <div className="panel-body">
        {tab === "bugs" && <BugPanel board={board} onJump={onJump} onUpdate={onUpdateBug} disabled={disabled} />}
        {tab === "people" && (
          <div className="people">
            {participants.map((p) => {
              const term = termOf(p.name);
              return (
                <div key={p.name} className={`person ${p.attention ? "alert" : ""}`}>
                  <Avatar name={p.name} color={colorOf(p.name)} size={34} online={p.online} alert={!!p.attention} />
                  <div className="person-info">
                    <div className="person-line">
                      <strong>{p.name}</strong>
                      <span className="muted small">{p.role || p.kind}</span>
                      {p.online && p.kind === "agent" && (
                        <span
                          className={`badge ${p.waiting || p.idle ? "st-idle" : "st-busy"}`}
                          title={p.idle ? "Đã kết thúc lượt. Nhắn cho nó: hub tự đánh thức nếu terminal chạy ngầm trên hub" : undefined}
                        >
                          {p.waiting ? "chờ việc" : p.idle ? "nghỉ" : "đang làm"}
                        </span>
                      )}
                      {!p.online && <span className="badge">offline</span>}
                    </div>
                    {p.attention && (
                      <div className="small attention">
                        <IconText text={p.attention} />
                      </div>
                    )}
                    {p.status && <div className="small muted person-status">{stripLeadingEmoji(p.status)}</div>}
                  </div>
                  {term && (
                    <button
                      className={`icon-btn ${openTerms.includes(p.name) ? "on" : ""}`}
                      title={openTerms.includes(p.name) ? "Ẩn terminal (session vẫn chạy ngầm)" : `Xem terminal của ${p.name}${term.running ? "" : " (đang tắt)"}`}
                      aria-label={`Terminal ${p.name}`}
                      onClick={() => onToggleTerm(p.name)}
                    >
                      <SquareTerminal className={`ic ${term.running ? "" : "muted"}`} />
                    </button>
                  )}
                </div>
              );
            })}
            {notJoined.length > 0 && (
              <div className="callout small">
                <span>Chạy ngầm, chưa vào phòng:</span>
                {notJoined.map((t) => (
                  <button key={t.name} className={`chip ${openTerms.includes(t.name) ? "on" : ""}`} onClick={() => onToggleTerm(t.name)}>
                    <SquareTerminal className="ic xs" /> {t.name}
                  </button>
                ))}
              </div>
            )}
            {participants.length === 0 && notJoined.length === 0 && <div className="panel-empty">Chưa có ai trong phòng.</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
