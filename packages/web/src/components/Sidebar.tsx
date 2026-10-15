import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  Ellipsis,
  Hash,
  Laptop,
  Moon,
  PanelLeftClose,
  Search,
  SquarePen,
  Sun,
  Trash2,
  Users,
  X,
  ExternalLink,
} from "lucide-react";
import type { RoomInfo } from "@tcm/shared";
import { Popover, MenuItem, MenuSep, MenuLabel } from "./ui/Popover";
import { ago, dateTime } from "../lib/format";
import { useTick, type Theme } from "../hooks";

export function Sidebar({
  rooms,
  room,
  onSelect,
  onNew,
  onDelete,
  onCollapse,
  theme,
  setTheme,
}: {
  rooms: RoomInfo[];
  room: string | null;
  onSelect: (r: string) => void;
  onNew: () => void;
  onDelete: (r: string) => void;
  onCollapse: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  useTick(60_000);
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);

  // Ctrl+K: tìm phòng (trừ khi đang gõ trong terminal: Ctrl+K là phím của Claude / shell)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".term-panel")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const groups = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = f ? rooms.filter((r) => r.name.toLowerCase().includes(f)) : rooms;
    return [
      { title: "Đang mở", items: list.filter((r) => !r.closedAt) },
      { title: "Đã đóng", items: list.filter((r) => r.closedAt) },
    ].filter((g) => g.items.length);
  }, [rooms, q]);

  return (
    <nav className="sidebar" aria-label="Danh sách phòng">
      <div className="sb-top">
        <div className="brand">
          <span className="brand-logo">
            <Users className="ic" />
          </span>
          Team Hub
        </div>
        <button className="icon-btn" onClick={onCollapse} title="Thu gọn sidebar" aria-label="Thu gọn sidebar">
          <PanelLeftClose className="ic" />
        </button>
      </div>

      <div className="sb-actions">
        <button className="sb-item sb-new" onClick={onNew}>
          <SquarePen className="ic" />
          <span>Phòng mới</span>
        </button>
        <label className="sb-search">
          <Search className="ic" />
          <input
            ref={search}
            value={q}
            placeholder="Tìm phòng"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQ("");
              if (e.key === "Enter" && groups[0]?.items[0]) onSelect(groups[0].items[0].name);
            }}
          />
          {q ? (
            <button className="icon-btn xs" onClick={() => setQ("")} aria-label="Xoá tìm kiếm">
              <X className="ic" />
            </button>
          ) : (
            <kbd>Ctrl K</kbd>
          )}
        </label>
      </div>

      <div className="sb-list">
        {rooms.length === 0 && (
          <div className="sb-empty">
            Chưa có phòng nào. Bấm <strong>Phòng mới</strong> để mở ticket, hoặc chạy <code>tcm start</code> trong repo.
          </div>
        )}
        {rooms.length > 0 && groups.length === 0 && <div className="sb-empty">Không có phòng khớp “{q}”.</div>}
        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="sb-group">{g.title}</h3>
            {g.items.map((r) => (
              <div key={r.name} className={`sb-room ${r.name === room ? "active" : ""} ${r.closedAt ? "closed" : ""}`}>
                <button
                  className="sb-room-main"
                  onClick={() => onSelect(r.name)}
                  title={r.closedAt ? `Đã đóng ${dateTime(r.closedAt)}` : `${r.messageCount} tin${r.onDuty ? " · đang trực" : " · nghỉ trực"}`}
                >
                  {r.closedAt ? <CircleCheck className="ic room-ic" /> : <Hash className="ic room-ic" />}
                  <span className="sb-room-name">{r.name}</span>
                  <span className="sb-room-meta">{ago(r.lastMessageAt ?? r.createdAt)}</span>
                </button>
                <Popover
                  placement="bottom-end"
                  trigger={(p, open) => (
                    <button {...p} className={`icon-btn xs sb-room-more ${open ? "open" : ""}`} aria-label={`Tuỳ chọn phòng ${r.name}`}>
                      <Ellipsis className="ic" />
                    </button>
                  )}
                >
                  <MenuItem icon={ExternalLink} onSelect={() => window.open(`#/${encodeURIComponent(r.name)}`, "_blank")}>
                    Mở trong tab mới
                  </MenuItem>
                  <MenuSep />
                  <MenuItem icon={Trash2} danger onSelect={() => onDelete(r.name)}>
                    Xoá phòng
                  </MenuItem>
                </Popover>
              </div>
            ))}
          </section>
        ))}
      </div>

      <div className="sb-foot">
        <div className="sb-user">
          <span className="avatar sm" style={{ ["--av" as string]: "var(--c-user)" }}>
            U
          </span>
          <span>user</span>
        </div>
        <Popover
          placement="top-end"
          trigger={(p) => (
            <button {...p} className="icon-btn" title="Giao diện" aria-label="Đổi giao diện sáng / tối">
              {theme === "dark" ? <Moon className="ic" /> : theme === "light" ? <Sun className="ic" /> : <Laptop className="ic" />}
            </button>
          )}
        >
          <MenuLabel>Giao diện</MenuLabel>
          <MenuItem icon={Laptop} checked={theme === "system"} onSelect={() => setTheme("system")}>
            Theo hệ thống
          </MenuItem>
          <MenuItem icon={Sun} checked={theme === "light"} onSelect={() => setTheme("light")}>
            Sáng
          </MenuItem>
          <MenuItem icon={Moon} checked={theme === "dark"} onSelect={() => setTheme("dark")}>
            Tối
          </MenuItem>
        </Popover>
      </div>
    </nav>
  );
}
