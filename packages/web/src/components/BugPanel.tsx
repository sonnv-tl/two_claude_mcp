import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, CircleDot, PartyPopper, Repeat, Scale, X } from "lucide-react";
import { BUG_STATUSES, BUG_STATUS_LABEL, type Board, type Bug, type BugStatus } from "@tcm/shared";
import { errText, timeHM } from "../lib/format";

export const OPEN_BUG: BugStatus[] = ["open", "reopened", "fixed", "disputed", "need_user"];
type Filter = "open" | "all";

export function BugPanel({
  board,
  onJump,
  onUpdate,
  disabled,
}: {
  board: Board;
  onJump: (msgId: number) => void;
  onUpdate: (code: string, status: BugStatus, note?: string) => Promise<unknown>;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const bugs = useMemo(() => {
    const list = filter === "open" ? board.bugs.filter((b) => OPEN_BUG.includes(b.status)) : board.bugs;
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
      {board.warning && (
        <div className="callout warn small">
          <Repeat className="ic" /> {board.warning}
        </div>
      )}
      <div className="bug-stats">
        <div>
          <strong>{board.bugs.length}</strong>
          <span>tổng</span>
        </div>
        <div className="st-open">
          <strong>{counts.open + counts.reopened + counts.fixed + counts.disputed}</strong>
          <span>đang mở</span>
        </div>
        <div className="st-verified">
          <strong>{counts.verified}</strong>
          <span>pass</span>
        </div>
        <div className="st-rejected">
          <strong>{counts.rejected}</strong>
          <span>không phải bug</span>
        </div>
        {counts.need_user > 0 && (
          <div className="st-need_user">
            <strong>{counts.need_user}</strong>
            <span>chờ phân xử</span>
          </div>
        )}
      </div>
      <div className="seg" role="tablist">
        {(["open", "all"] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "open" ? "Đang mở" : "Tất cả"}
          </button>
        ))}
      </div>
      {bugs.length === 0 && (
        <div className="panel-empty">
          {board.bugs.length ? (
            <>
              <PartyPopper className="ic lg tone-ok" /> Không còn bug mở
            </>
          ) : (
            "Chưa có bug."
          )}
        </div>
      )}
      {bugs.map((b) => (
        <BugCard key={b.code} bug={b} onJump={onJump} onUpdate={onUpdate} disabled={disabled} />
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
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const rounds = Object.entries(bug.rounds);

  return (
    <div className={`bug st-${bug.status}`}>
      <div className="bug-head">
        <button className="bug-code" onClick={() => onJump(bug.msgId)} title="Xem tin báo bug">
          {bug.code}
        </button>
        <span className={`sev sev-${bug.severity}`}>{bug.severity}</span>
        <span className={`badge st-${bug.status}`}>
          {bug.status === "need_user" ? <Scale className="ic xs" /> : <CircleDot className="ic xs" />}
          {BUG_STATUS_LABEL[bug.status]}
        </span>
        <button className="icon-btn xs toggle" onClick={() => setOpen(!open)} aria-label={open ? "Thu gọn" : "Mở rộng"}>
          {open ? <ChevronUp className="ic" /> : <ChevronDown className="ic" />}
        </button>
      </div>
      <div className="bug-title">{bug.title}</div>
      <div className="small muted bug-meta">
        {bug.tc && <span>{bug.tc}</span>}
        <span>
          {bug.reporter} <ArrowRight className="ic xs" /> {bug.assignee}
        </span>
        {rounds.length > 0 && <span>tranh luận {rounds.map(([n, c]) => `${n} ${c}`).join(", ")}</span>}
      </div>
      {open && (
        <div className="bug-body">
          <ol className="bug-events small">
            {bug.events.map((e, i) => (
              <li key={i}>
                <button className="link" disabled={!e.msgId} onClick={() => e.msgId && onJump(e.msgId)}>
                  {timeHM(e.at)}
                </button>{" "}
                <strong>{e.actor}</strong>: {e.from && <>{BUG_STATUS_LABEL[e.from]} <ArrowRight className="ic xs" /> </>}
                {BUG_STATUS_LABEL[e.to]}
                {e.note && <div className="muted ev-note">{e.note.slice(0, 200)}</div>}
              </li>
            ))}
          </ol>
          <textarea
            className="field"
            rows={2}
            placeholder={bug.status === "need_user" ? "Kết luận của bạn (gửi cho cả DEV và QA)" : "Ghi chú (tuỳ chọn)"}
            value={note}
            disabled={disabled || busy}
            onChange={(e) => setNote(e.target.value)}
          />
          {bug.status === "need_user" ? (
            <div className="bug-actions">
              <button className="btn primary" disabled={disabled || busy} onClick={() => void apply("open")} title="DEV phải fix">
                <Check className="ic" /> Là bug, DEV fix
              </button>
              <button className="btn" disabled={disabled || busy} onClick={() => void apply("rejected")}>
                <X className="ic" /> Không phải bug
              </button>
            </div>
          ) : (
            <div className="bug-actions">
              <select className="field" value={status} onChange={(e) => setStatus(e.target.value as BugStatus)} disabled={disabled || busy}>
                {BUG_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {BUG_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={disabled || busy || status === bug.status} onClick={() => void apply(status)}>
                Đổi
              </button>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
