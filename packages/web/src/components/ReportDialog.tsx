import { useEffect, useState } from "react";
import { BellRing, CircleCheck, Copy, Download, Eye, FileText, Flag, Pencil, RotateCcw, Save, WandSparkles } from "lucide-react";
import { BROADCAST, reportDraft, type Board } from "@tcm/shared";
import type { OutgoingMessage } from "../useRoom";
import { Modal } from "./ui/Modal";
import { Markdown } from "./Markdown";
import { postJson, roomApi } from "../lib/api";
import { dateTime, errText } from "../lib/format";

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
    fetch(roomApi(room, "meta"))
      .then((r) => r.json())
      .then((m: { ticket?: string }) => m.ticket && setTicket(m.ticket))
      .catch(() => {});
  }, [room]);

  // Agent gửi phiên bản mới trong lúc đang mở: cập nhật nếu user chưa sửa gì
  useEffect(() => {
    if (!editing || !dirty) setText(report?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (dirty) await postJson(roomApi(room, "report"), { content: text });
    setEditing(false);
  };

  const closed = !!board.closedAt;

  return (
    <Modal
      title={`Báo cáo B7 · ${ticket}`}
      icon={FileText}
      size="lg"
      onClose={onClose}
      badge={
        <span className={`badge ${closed ? "st-verified" : "st-open"}`}>
          {closed ? <CircleCheck className="ic xs" /> : <Flag className="ic xs" />}
          {closed ? `Đã đóng ${dateTime(board.closedAt!)}` : "Đang mở"}
        </span>
      }
      footer={
        <>
          {dirty && (
            <button className="btn" disabled={busy} onClick={() => void run(async () => (await save(), "Đã lưu phiên bản mới."))}>
              <Save className="ic" /> Lưu
            </button>
          )}
          <button
            className="btn"
            disabled={busy || !text.trim()}
            title="Copy báo cáo (markdown) vào clipboard"
            onClick={() =>
              void run(async () => {
                await navigator.clipboard.writeText(text);
                return "Đã copy báo cáo (markdown).";
              })
            }
          >
            <Copy className="ic" /> Copy markdown
          </button>
          {closed ? (
            <button className="btn primary" disabled={busy} onClick={() => void run(async () => (await postJson(roomApi(room, "reopen")), "Đã mở lại ticket, bật trực."))}>
              <RotateCcw className="ic" /> Mở lại ticket
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={busy}
              title="Duyệt báo cáo: lưu, đóng ticket, tắt trực. Agent kết thúc lượt; nhắn cho agent thì nó được đánh thức."
              onClick={() =>
                void run(async () => {
                  if (!text.trim() && !confirm("Chưa có báo cáo B7. Vẫn đóng ticket?")) return;
                  await postJson(roomApi(room, "close"), dirty ? { report: text } : {});
                  setEditing(false);
                  return "Đã duyệt và đóng ticket. Agent kết thúc lượt, không trực nữa. Cần gì thì cứ nhắn: agent chạy ngầm trên hub sẽ được đánh thức.";
                })
              }
            >
              <CircleCheck className="ic" />
              {dirty ? "Lưu, duyệt & đóng ticket" : text.trim() ? "Duyệt & đóng ticket" : "Đóng ticket"}
            </button>
          )}
        </>
      }
    >
      <div className="small muted">
        {report
          ? `Phiên bản ${board.reportVersions} · ${report.author} · ${dateTime(report.createdAt)}`
          : "Chưa có báo cáo. QA gửi bằng submit_report ở bước B7, hoặc bạn tự viết (tạo nháp từ bảng bug)."}
      </div>
      <div className="report-tools">
        <div className="seg">
          <button className={editing ? "" : "on"} onClick={() => setEditing(false)}>
            <Eye className="ic" /> Xem
          </button>
          <button className={editing ? "on" : ""} onClick={() => setEditing(true)}>
            <Pencil className="ic" /> Sửa
          </button>
        </div>
        {(editing || !report) && (
          <button className="btn ghost sm" onClick={() => (setText(reportDraft(ticket, board)), setEditing(true))} title="Ghi đè ô soạn bằng nháp từ bảng bug">
            <WandSparkles className="ic" /> Tạo nháp từ bảng bug
          </button>
        )}
        {!report && !closed && (
          <button
            className="btn ghost sm"
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
            <BellRing className="ic" /> Nhắc DEV/QA gửi báo cáo
          </button>
        )}
        {report && (
          <a className="btn ghost sm" href={roomApi(room, "report.md")} download>
            <Download className="ic" /> Tải .md
          </a>
        )}
      </div>
      {editing ? (
        <textarea className="field report-edit" value={text} onChange={(e) => setText(e.target.value)} placeholder="Báo cáo tổng kết (markdown)" />
      ) : (
        <div className="preview report-view">
          <Markdown>{text || "_Chưa có báo cáo_"}</Markdown>
        </div>
      )}
      {notice && <div className="notice small">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
