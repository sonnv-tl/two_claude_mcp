import { useEffect, useMemo, useState } from "react";
import {
  BUG_STATUSES,
  BUG_STATUS_LABEL,
  STEPS,
  STEP_LABEL,
  fmtDuration,
  stepSummary,
  type Board,
  type Bug,
  type BugStatus,
  type Participant,
} from "@tcm/shared";

/** Re-render định kỳ để thời gian "đang ở bước này" tự tăng */
function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function Stepper({ board, colorOf }: { board: Board; colorOf: (name: string) => string }) {
  useTick();
  const sum = stepSummary(board.steps);
  if (!sum.size) return null;
  const agents = [...sum.entries()];
  return (
    <div className="stepper">
      {STEPS.map((st) => {
        const here = agents.filter(([, s]) => s.current === st);
        const passed = agents.length > 0 && agents.every(([, s]) => STEPS.indexOf(s.current) > STEPS.indexOf(st));
        const spent = agents.filter(([, s]) => s.spent[st]);
        return (
          <div key={st} className={`step ${here.length ? "current" : ""} ${passed ? "done" : ""}`} title={STEP_LABEL[st]}>
            <div className="step-head">
              <strong>{st}</strong> <span className="muted">{STEP_LABEL[st]}</span>
            </div>
            <div className="step-who">
              {here.map(([name]) => (
                <span key={name} className="who" style={{ background: colorOf(name) }}>
                  {name}
                </span>
              ))}
            </div>
            {spent.length > 0 && (
              <div className="small muted">{spent.map(([name, s]) => `${name} ${fmtDuration(s.spent[st]!)}`).join(" · ")}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const OPEN: BugStatus[] = ["open", "reopened", "fixed", "disputed", "need_user"];
type Filter = "open" | "all";

export function BugPanel({
  board,
  participants,
  onJump,
  onUpdate,
  disabled,
}: {
  board: Board;
  participants: Participant[];
  onJump: (msgId: number) => void;
  onUpdate: (code: string, status: BugStatus, note?: string) => Promise<unknown>;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const bugs = useMemo(() => {
    const list = filter === "open" ? board.bugs.filter((b) => OPEN.includes(b.status)) : board.bugs;
    // need_user lên đầu, rồi theo mức độ
    const rank = (b: Bug) => (b.status === "need_user" ? 0 : 1) * 10 + ["high", "med", "low"].indexOf(b.severity);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
  }, [board.bugs, filter]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(BUG_STATUSES.map((s) => [s, 0])) as Record<BugStatus, number>;
    board.bugs.forEach((b) => c[b.status]++);
    return c;
  }, [board.bugs]);

  return (
    <div className="bugs">
      {board.warning && <div className="warn small">🔁 {board.warning}</div>}
      <div className="bug-summary small">
        <span>Tổng {board.bugs.length}</span>
        <span className="st-verified">✓ {counts.verified}</span>
        <span className="st-rejected">✗ {counts.rejected}</span>
        <span className="st-open">mở {counts.open + counts.reopened + counts.fixed + counts.disputed}</span>
        {counts.need_user > 0 && <span className="st-need_user">⚖️ {counts.need_user}</span>}
      </div>
      <div className="filters">
        {(["open", "all"] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? "" : "off-soft"}`} onClick={() => setFilter(f)}>
            {f === "open" ? "Đang mở" : "Tất cả"}
          </button>
        ))}
      </div>
      {bugs.length === 0 && <div className="muted small">{board.bugs.length ? "Không còn bug mở 🎉" : "Chưa có bug."}</div>}
      {bugs.map((b) => (
        <BugCard key={b.code} bug={b} participants={participants} onJump={onJump} onUpdate={onUpdate} disabled={disabled} />
      ))}
    </div>
  );
}

function BugCard({
  bug,
  onJump,
  onUpdate,
  disabled,
}: {
  bug: Bug;
  participants: Participant[];
  onJump: (msgId: number) => void;
  onUpdate: (code: string, status: BugStatus, note?: string) => Promise<unknown>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(bug.status === "need_user");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<BugStatus>(bug.status === "need_user" ? "open" : bug.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (bug.status === "need_user") setOpen(true);
  }, [bug.status]);

  const apply = async (s: BugStatus) => {
    setBusy(true);
    setError(null);
    try {
      await onUpdate(bug.code, s, note.trim() || undefined);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const rounds = Object.entries(bug.rounds);

  return (
    <div className={`bug st-${bug.status}`}>
      <div className="bug-head">
        <button className="link code" onClick={() => onJump(bug.msgId)} title="Xem tin báo bug">
          {bug.code}
        </button>
        <span className={`sev sev-${bug.severity}`}>{bug.severity}</span>
        <span className={`chip st-${bug.status}`}>{BUG_STATUS_LABEL[bug.status]}</span>
        <button className="link small toggle" onClick={() => setOpen(!open)}>
          {open ? "▴" : "▾"}
        </button>
      </div>
      <div className="bug-title">{bug.title}</div>
      <div className="small muted">
        {[bug.tc, `${bug.reporter} → ${bug.assignee}`, rounds.length ? `tranh luận ${rounds.map(([n, c]) => `${n} ${c}`).join(", ")}` : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {open && (
        <div className="bug-body">
          <ol className="bug-events small">
            {bug.events.map((e, i) => (
              <li key={i}>
                <button className="link" disabled={!e.msgId} onClick={() => e.msgId && onJump(e.msgId)}>
                  {new Date(e.at).toLocaleTimeString("vi-VN", { hour12: false, hour: "2-digit", minute: "2-digit" })}
                </button>{" "}
                <strong>{e.actor}</strong>: {e.from ? `${BUG_STATUS_LABEL[e.from]} → ` : ""}
                {BUG_STATUS_LABEL[e.to]}
                {e.note && <div className="muted ev-note">{e.note.slice(0, 200)}</div>}
              </li>
            ))}
          </ol>
          <textarea
            className="bug-note"
            rows={2}
            placeholder={bug.status === "need_user" ? "Kết luận của bạn (gửi cho cả DEV và QA)" : "Ghi chú (tuỳ chọn)"}
            value={note}
            disabled={disabled || busy}
            onChange={(e) => setNote(e.target.value)}
          />
          {bug.status === "need_user" ? (
            <div className="bug-actions">
              <button className="send" disabled={disabled || busy} onClick={() => void apply("open")} title="DEV phải fix">
                Là bug → DEV fix
              </button>
              <button className="secondary" disabled={disabled || busy} onClick={() => void apply("rejected")}>
                Không phải bug
              </button>
            </div>
          ) : (
            <div className="bug-actions">
              <select value={status} onChange={(e) => setStatus(e.target.value as BugStatus)} disabled={disabled || busy}>
                {BUG_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {BUG_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <button className="secondary" disabled={disabled || busy || status === bug.status} onClick={() => void apply(status)}>
                Đổi
              </button>
            </div>
          )}
          {error && <div className="composer-error small">{error}</div>}
        </div>
      )}
    </div>
  );
}
