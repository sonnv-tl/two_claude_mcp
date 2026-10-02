import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BROADCAST, reportDraft, type Board } from "@tcm/shared";
import type { OutgoingMessage } from "./useRoom";

const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour12: false });

async function post<T>(room: string, sub: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(room)}/${sub}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}

/** Báo cáo B7: xem / sửa, tải .md, copy markdown, đóng hoặc mở lại ticket. Không ghi gì lên Backlog. */
export function ReportDialog({
  room,
  board,
  send,
  onClose,
}: {
  room: string;
  board: Board;
  send: (m: OutgoingMessage) => Promise<unknown>;
  onClose: () => void;
}) {
  const report = board.report;
  const [text, setText] = useState(report?.content ?? "");
  const [editing, setEditing] = useState(!report);
  const [ticket, setTicket] = useState(room);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = text.trim() !== (report?.content ?? "").trim() && !!text.trim();

  useEffect(() => {
    fetch(`/api/rooms/${encodeURIComponent(room)}/meta`)
      .then((r) => r.json())
      .then((m: { ticket?: string }) => m.ticket && setTicket(m.ticket))
      .catch(() => {});
  }, [room]);

  // Agent gửi phiên bản mới trong lúc đang mở: cập nhật nếu user chưa sửa gì
  useEffect(() => {
    if (!editing || !dirty) setText(report?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (dirty) await post(room, "report", { content: text });
    setEditing(false);
  };

  const closed = !!board.closedAt;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Báo cáo B7">
        <header className="modal-head">
          <strong>🏁 Báo cáo B7 · {ticket}</strong>
          <span className={`chip ${closed ? "st-verified" : "st-open"}`}>{closed ? `Đã đóng ${fmt(board.closedAt!)}` : "Đang mở"}</span>
          <button className="link" onClick={onClose}>đóng</button>
        </header>
        <div className="modal-body">
          <div className="small muted">
            {report
              ? `Phiên bản ${board.reportVersions} · ${report.author} · ${fmt(report.createdAt)}`
              : "Chưa có báo cáo. QA gửi bằng submit_report ở bước B7, hoặc bạn tự viết (tạo nháp từ bảng bug)."}
          </div>
          <div className="report-tools">
            <button className={`chip ${editing ? "off-soft" : ""}`} onClick={() => setEditing(false)}>Xem</button>
            <button className={`chip ${editing ? "" : "off-soft"}`} onClick={() => setEditing(true)}>Sửa</button>
            {(editing || !report) && (
              <button className="link small" onClick={() => (setText(reportDraft(ticket, board)), setEditing(true))} title="Ghi đè ô soạn bằng nháp từ bảng bug">
                tạo nháp từ bảng bug
              </button>
            )}
            {!report && !closed && (
              <button
                className="link small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await send({
                      to: BROADCAST,
                      type: "question",
                      content: "[B7] Gửi tôi báo cáo tổng kết chung: QA soạn nháp (số liệu từ get_board), DEV bổ sung phần kỹ thuật, rồi QA gửi bằng `submit_report`.",
                    });
                    return "Đã nhắc DEV/QA gửi báo cáo.";
                  })
                }
              >
                nhắc DEV/QA gửi báo cáo
              </button>
            )}
            {report && (
              <a className="link small" href={`/api/rooms/${encodeURIComponent(room)}/report.md`} download>
                tải .md
              </a>
            )}
          </div>
          {editing ? (
            <textarea className="report-edit" value={text} onChange={(e) => setText(e.target.value)} placeholder="Báo cáo tổng kết (markdown)" />
          ) : (
            <div className="kickoff-preview md report-view">
              <Markdown remarkPlugins={[remarkGfm]}>{text || "_Chưa có báo cáo_"}</Markdown>
            </div>
          )}
          {notice && <div className="small notice">{notice}</div>}
          {error && <div className="composer-error small">{error}</div>}
        </div>
        <footer className="modal-foot">
          {dirty && (
            <button className="secondary" disabled={busy} onClick={() => void run(async () => (await save(), "Đã lưu phiên bản mới."))}>
              Lưu
            </button>
          )}
          <button
            className="secondary"
            disabled={busy || !text.trim()}
            title="Copy báo cáo (markdown) vào clipboard"
            onClick={() =>
              void run(async () => {
                await navigator.clipboard.writeText(text);
                return "Đã copy báo cáo (markdown).";
              })
            }
          >
            Copy markdown
          </button>
          {closed ? (
            <button className="send" disabled={busy} onClick={() => void run(async () => (await post(room, "reopen"), "Đã mở lại ticket, bật trực."))}>
              Mở lại ticket
            </button>
          ) : (
            <button
              className="send"
              disabled={busy}
              title="Lưu báo cáo, tắt trực, agent dừng việc và kết thúc lượt"
              onClick={() =>
                void run(async () => {
                  if (!text.trim() && !confirm("Chưa có báo cáo B7. Vẫn đóng ticket?")) return;
                  await post(room, "close", dirty ? { report: text } : {});
                  setEditing(false);
                  return "Đã đóng ticket. Agent sẽ kết thúc lượt. Vào lại: tcm resume.";
                })
              }
            >
              {dirty ? "Lưu & đóng ticket" : "Đóng ticket"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
