import { useEffect, useMemo, useState } from "react";
import { Send, Save, Ticket } from "lucide-react";
import { buildKickoff, type KickoffMeta } from "@tcm/shared";
import { Modal } from "./ui/Modal";
import { Markdown } from "./Markdown";
import { postJson, roomApi } from "../lib/api";
import { errText } from "../lib/format";

const FIELDS: { key: keyof KickoffMeta; label: string; placeholder: string; wide?: boolean }[] = [
  { key: "ticket", label: "Mã ticket", placeholder: "TLPORTAL-10182" },
  { key: "testAccount", label: "Tài khoản test", placeholder: "100000 / Password_1" },
  { key: "figma", label: "Link Figma (thay cho link trong ticket)", placeholder: "https://www.figma.com/design/…?node-id=…", wide: true },
  { key: "appRun", label: "Lệnh chạy app", placeholder: "npm run dev" },
  { key: "appUrl", label: "URL app", placeholder: "http://localhost:8888" },
  { key: "notes", label: "Ghi chú (phạm vi, lưu ý…)", placeholder: "", wide: true },
];

export function KickoffDialog({ room, onClose }: { room: string; onClose: () => void }) {
  const [meta, setMeta] = useState<KickoffMeta>({ ticket: room });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(roomApi(room, "meta"))
      .then((r) => r.json())
      .then((m: Partial<KickoffMeta>) => setMeta({ ticket: room, ...m }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [room]);

  const preview = useMemo(() => (meta.ticket?.trim() ? buildKickoff(meta) : ""), [meta]);

  const submit = async (send: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await postJson(roomApi(room, send ? "kickoff" : "meta"), { meta, send });
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Kickoff ticket · ${room}`}
      icon={Ticket}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="btn" disabled={busy || !meta.ticket?.trim()} onClick={() => void submit(false)}>
            <Save className="ic" /> Lưu, chưa gửi
          </button>
          <button className="btn primary" disabled={busy || !meta.ticket?.trim()} onClick={() => void submit(true)}>
            <Send className="ic" /> Gửi kickoff cho @all
          </button>
        </>
      }
    >
      <div className="form grid-2">
        {FIELDS.map((f) => (
          <label key={f.key} className={`field-label ${f.wide ? "wide" : ""}`}>
            <span>{f.label}</span>
            {f.key === "notes" ? (
              <textarea className="field" rows={2} value={meta[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setMeta({ ...meta, [f.key]: e.target.value })} />
            ) : (
              <input
                className="field"
                value={meta[f.key] ?? ""}
                placeholder={f.placeholder}
                disabled={loading}
                onChange={(e) => setMeta({ ...meta, [f.key]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      <div className="small muted">Xem trước (gửi tới @all dưới tên user):</div>
      <div className="preview">
        <Markdown>{preview || "_Nhập mã ticket_"}</Markdown>
      </div>
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
