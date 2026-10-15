import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderGit2, LoaderCircle, Rocket, SquarePen, TriangleAlert } from "lucide-react";
import type { RepoInfo, RepoRef, RoomInfo, StartTicketRequest } from "@tcm/shared";
import { Modal } from "./ui/Modal";
import { getJson, postJson } from "../lib/api";
import { errText } from "../lib/format";
import { useLocalStorage } from "../hooks";

const NAME_RE = /^[a-zA-Z0-9_.-]{1,40}$/;
const OTHER = "__other__";
const repoKey = (r: RepoRef) => (r.wslCwd ? `${r.distro ?? ""}:${r.wslCwd}` : r.repoDir.toLowerCase());

/** Đường dẫn gõ tay → repo: "/home/…" là repo trong WSL, còn lại là đường dẫn Windows */
function manualRepo(path: string, distro: string): RepoRef | null {
  const p = path.trim().replace(/[\\/]+$/, "");
  if (!p) return null;
  if (p.startsWith("/")) {
    const d = distro.trim() || "Ubuntu";
    return { repoDir: `\\\\wsl.localhost\\${d}${p.replace(/\//g, "\\")}`, wslCwd: p, distro: d };
  }
  return { repoDir: p };
}

/**
 * Mở ticket mới, giống task "tcm: start ticket" trong VS Code: nhập mã ticket + link Figma,
 * hub đọc .team-hub.json của repo, chạy ngầm DEV + QA rồi gửi kickoff.
 */
export function NewRoomDialog({ rooms, onClose, onCreated }: { rooms: RoomInfo[]; onClose: () => void; onCreated: (room: string) => void }) {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [lastRepo, setLastRepo] = useLocalStorage<string>("tcm.lastRepo", "");
  const [pick, setPick] = useState("");
  const [manual, setManual] = useState({ path: "", distro: "Ubuntu" });
  const [ticket, setTicket] = useState("");
  const [figma, setFigma] = useState("");
  const [room, setRoom] = useState("");
  const [account, setAccount] = useState("");
  const [notes, setNotes] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<RepoInfo[]>("/api/repos")
      .then((list) => {
        setRepos(list);
        const keep = list.find((r) => repoKey(r) === lastRepo && !r.error) ?? list.find((r) => !r.error);
        setPick(keep ? repoKey(keep) : OTHER);
      })
      .catch((e) => {
        setRepos([]);
        setPick(OTHER);
        setError(`Không tải được danh sách repo: ${errText(e)}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const picked = repos?.find((r) => repoKey(r) === pick);
  const repo: RepoRef | null = pick === OTHER ? manualRepo(manual.path, manual.distro) : picked ?? null;
  const roomName = (room.trim() || ticket.trim()).replace(/\s+/g, "-");
  const existing = useMemo(() => rooms.find((r) => r.name === roomName), [rooms, roomName]);
  const nameOk = !roomName || NAME_RE.test(roomName);
  const canSubmit = !busy && !!ticket.trim() && nameOk && !!repo;

  const submit = async () => {
    if (!canSubmit || !repo) return;
    if (existing?.messageCount && !confirm(`Phòng "${roomName}" đã có ${existing.messageCount} tin.\n\nGửi kickoff mới và chạy lại DEV/QA (session cũ bị thay)?`)) return;
    setBusy(true);
    setError(null);
    try {
      const body: StartTicketRequest = {
        ticket: ticket.trim(),
        room: roomName,
        figma: figma.trim() || undefined,
        testAccount: account.trim() || undefined,
        notes: notes.trim() || undefined,
        repo: { repoDir: repo.repoDir, wslCwd: repo.wslCwd, distro: repo.distro },
      };
      const r = await postJson<{ room: string }>("/api/start", body);
      setLastRepo(repoKey(repo));
      onCreated(r.room);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Phòng mới"
      icon={SquarePen}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <LoaderCircle className="ic spin" /> : <Rocket className="ic" />}
            {existing ? "Mở lại & gửi kickoff" : "Tạo phòng & bắt đầu"}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted small form-lead">
          Giống <code>tcm start</code>: hub đọc <code>.team-hub.json</code> của repo, chạy ngầm DEV + QA rồi gửi kickoff cho cả hai.
        </p>
        <label className="field-label">
          <span>Mã ticket</span>
          <input className="field" value={ticket} placeholder="TLPORTAL-10182" onChange={(e) => setTicket(e.target.value)} disabled={busy} />
          {!nameOk && <span className="form-error">Tên phòng chỉ gồm chữ, số, _ . - (tối đa 40 ký tự)</span>}
        </label>
        <label className="field-label">
          <span>Link Figma</span>
          <input
            className="field"
            value={figma}
            placeholder={picked?.figma ? `Mặc định: ${picked.figma}` : "Để trống = dùng link trong ticket"}
            onChange={(e) => setFigma(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field-label">
          <span>Repo</span>
          {repos === null ? (
            <div className="field muted">
              <LoaderCircle className="ic spin xs" /> Đang tải…
            </div>
          ) : (
            <div className="field-icon">
              <FolderGit2 className="ic" />
              <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
                {repos.map((r) => (
                  <option key={repoKey(r)} value={repoKey(r)} disabled={!!r.error}>
                    {r.label}
                    {r.error ? ` (${r.error})` : r.hasConfig ? "" : " (chưa có .team-hub.json)"}
                  </option>
                ))}
                <option value={OTHER}>Repo khác…</option>
              </select>
            </div>
          )}
          {picked && !picked.hasConfig && <span className="small muted">Repo chưa có .team-hub.json: dùng mặc định (chạy tcm init trong repo để cấu hình).</span>}
        </label>
        {pick === OTHER && (
          <div className="form-row">
            <label className="field-label grow">
              <span>Đường dẫn repo</span>
              <input
                className="field"
                value={manual.path}
                placeholder="/home/labdev/thankslab-portal hoặc C:\laragon\www\app"
                onChange={(e) => setManual({ ...manual, path: e.target.value })}
                disabled={busy}
              />
            </label>
            {manual.path.trim().startsWith("/") && (
              <label className="field-label">
                <span>Distro WSL</span>
                <input className="field" value={manual.distro} onChange={(e) => setManual({ ...manual, distro: e.target.value })} disabled={busy} />
              </label>
            )}
          </div>
        )}

        <button type="button" className={`disclosure ${more ? "open" : ""}`} onClick={() => setMore(!more)}>
          <ChevronRight className="ic xs" /> Tuỳ chọn thêm
        </button>
        {more && (
          <>
            <label className="field-label">
              <span>Tên phòng</span>
              <input className="field" value={room} placeholder={ticket.trim() || "mặc định = mã ticket"} onChange={(e) => setRoom(e.target.value)} disabled={busy} />
            </label>
            <label className="field-label">
              <span>Tài khoản test</span>
              <input
                className="field"
                value={account}
                placeholder={picked?.testAccount ? `Mặc định: ${picked.testAccount}` : "100000 / Password_1"}
                onChange={(e) => setAccount(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="field-label">
              <span>Ghi chú</span>
              <textarea className="field" rows={2} value={notes} placeholder="Phạm vi, lưu ý…" onChange={(e) => setNotes(e.target.value)} disabled={busy} />
            </label>
          </>
        )}

        {existing && (
          <div className="callout warn small">
            <TriangleAlert className="ic" />
            <span>
              Phòng <strong>{existing.name}</strong> đã có {existing.messageCount} tin{existing.closedAt ? " (đã đóng, sẽ mở lại)" : ""}. Muốn làm tiếp việc dở thì
              mở phòng đó và bấm chạy lại trong Terminal.
            </span>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
