import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildKickoff, type KickoffMeta } from "@tcm/shared";

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
    fetch(`/api/rooms/${encodeURIComponent(room)}/meta`)
      .then((r) => r.json())
      .then((m: Partial<KickoffMeta>) => setMeta({ ticket: room, ...m }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [room]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const preview = useMemo(() => (meta.ticket?.trim() ? buildKickoff(meta) : ""), [meta]);

  const submit = async (send: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(room)}/${send ? "kickoff" : "meta"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meta, send }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Kickoff ticket">
        <header className="modal-head">
          <strong>🎫 Kickoff ticket · #{room}</strong>
          <button className="link" onClick={onClose}>đóng</button>
        </header>
        <div className="modal-body">
          <div className="kickoff-form">
            {FIELDS.map((f) => (
              <label key={f.key} className={f.wide ? "wide" : ""}>
                <span className="small muted">{f.label}</span>
                {f.key === "notes" ? (
                  <textarea
                    rows={2}
                    value={meta[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => setMeta({ ...meta, [f.key]: e.target.value })}
                  />
                ) : (
                  <input
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
          <div className="kickoff-preview md">
            <Markdown remarkPlugins={[remarkGfm]}>{preview || "_Nhập mã ticket_"}</Markdown>
          </div>
          {error && <div className="composer-error small">{error}</div>}
        </div>
        <footer className="modal-foot">
          <button className="secondary" disabled={busy || !meta.ticket?.trim()} onClick={() => void submit(false)}>
            Lưu, chưa gửi
          </button>
          <button className="send" disabled={busy || !meta.ticket?.trim()} onClick={() => void submit(true)}>
            Gửi kickoff cho @all
          </button>
        </footer>
      </div>
    </div>
  );
}
