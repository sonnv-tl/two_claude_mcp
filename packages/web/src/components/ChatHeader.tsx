import {
  Bug,
  ChevronDown,
  CircleCheck,
  FileText,
  Flag,
  ListFilter,
  Menu as MenuIcon,
  Moon,
  PanelLeftOpen,
  Radio,
  SquarePen,
  SquareTerminal,
  Ticket,
  Trash2,
  Users,
} from "lucide-react";
import { MESSAGE_TYPES, type Board, type MessageType, type Participant, type RoomInfo, type TermInfo } from "@tcm/shared";
import { Popover, MenuItem, MenuLabel, MenuSep } from "./ui/Popover";
import { Avatar } from "./ui/Avatar";
import { ProgressPill } from "./Progress";
import { OPEN_BUG } from "./BugPanel";
import { TYPE_ICON, TYPE_LABEL, HUMAN } from "../lib/types";
import type { ConnState } from "../useRoom";
import { dateTime } from "../lib/format";

export type Panel = null | "people" | "bugs" | "terminal";

export function ChatHeader({
  room,
  info,
  conn,
  onDuty,
  board,
  participants,
  terms,
  colorOf,
  sidebarHidden,
  onShowSidebar,
  onNew,
  hidden,
  toggleType,
  resetTypes,
  panel,
  setPanel,
  onKickoff,
  onReport,
  onToggleDuty,
  onDelete,
}: {
  room: string | null;
  info: RoomInfo | undefined;
  conn: ConnState;
  onDuty: boolean;
  board: Board;
  participants: Participant[];
  terms: TermInfo[];
  colorOf: (name: string) => string;
  sidebarHidden: boolean;
  onShowSidebar: () => void;
  onNew: () => void;
  hidden: Set<MessageType>;
  toggleType: (t: MessageType) => void;
  resetTypes: () => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  onKickoff: () => void;
  onReport: () => void;
  onToggleDuty: () => void;
  onDelete: () => void;
}) {
  const openBugs = board.bugs.filter((b) => OPEN_BUG.includes(b.status)).length;
  const needUser = board.bugs.some((b) => b.status === "need_user");
  const agents = participants.filter((p) => p.name !== HUMAN);
  const alert = agents.some((p) => p.attention);
  const closed = !!board.closedAt;
  const live = conn === "open";
  const toggle = (p: Exclude<Panel, null>) => setPanel(panel === p ? null : p);

  return (
    <header className="chat-head">
      {sidebarHidden && (
        <>
          <button className="icon-btn" onClick={onShowSidebar} title="Mở sidebar" aria-label="Mở sidebar">
            <span className="only-wide">
              <PanelLeftOpen className="ic" />
            </span>
            <span className="only-narrow">
              <MenuIcon className="ic" />
            </span>
          </button>
          <button className="icon-btn new-btn" onClick={onNew} title="Phòng mới" aria-label="Phòng mới">
            <SquarePen className="ic" />
          </button>
        </>
      )}

      {room ? (
        <Popover
          placement="bottom-start"
          width={260}
          trigger={(p, open) => (
            <button {...p} className={`room-btn ${open ? "open" : ""}`} title="Tuỳ chọn phòng">
              <span className={`conn-dot ${conn}`} title={live ? "Đang kết nối (live)" : conn === "connecting" ? "Đang kết nối…" : "Mất kết nối"} />
              <span className="room-title">{room}</span>
              <ChevronDown className="ic xs" />
            </button>
          )}
        >
          <MenuLabel>
            {closed ? `Đã đóng ${dateTime(board.closedAt!)}` : `${info?.messageCount ?? 0} tin · ${onDuty ? "đang trực" : "nghỉ trực"}`}
          </MenuLabel>
          <MenuItem icon={Ticket} onSelect={onKickoff}>
            Kickoff ticket
          </MenuItem>
          <MenuItem icon={closed ? CircleCheck : board.report ? FileText : Flag} onSelect={onReport} hint={board.report && !closed ? "chờ duyệt" : undefined}>
            {closed ? "Báo cáo B7 (đã đóng)" : board.report ? "Báo cáo B7, đóng ticket" : "Đóng ticket"}
          </MenuItem>
          <MenuItem icon={Users} onSelect={() => setPanel("people")} hint={`${agents.filter((a) => a.online).length}/${agents.length} online`}>
            Thành viên
          </MenuItem>
          <MenuItem icon={onDuty ? Moon : Radio} onSelect={onToggleDuty} disabled={!live}>
            {onDuty ? "Tắt trực (cho agent nghỉ)" : "Bật trực"}
          </MenuItem>
          <MenuSep />
          <MenuItem icon={Trash2} danger onSelect={onDelete} disabled={!info}>
            Xoá phòng
          </MenuItem>
        </Popover>
      ) : (
        <span className="room-title muted">Team Hub</span>
      )}

      {room && (
        <div className="head-pills">
          {closed ? (
            <span className="pill ok" title={`Đã đóng ${dateTime(board.closedAt!)}`}>
              <CircleCheck className="ic xs" /> Đã đóng
            </span>
          ) : (
            <button
              className={`pill ${onDuty ? "on" : ""}`}
              disabled={!live}
              onClick={onToggleDuty}
              title={onDuty ? "Agent ở lại chờ việc sau mỗi lượt. Bấm để cho agent kết thúc lượt." : "Agent kết thúc lượt khi xong việc. Bấm để bật lại."}
            >
              {onDuty ? <Radio className="ic xs" /> : <Moon className="ic xs" />}
              {onDuty ? "Đang trực" : "Nghỉ trực"}
            </button>
          )}
          {board.report && !closed && (
            <button className="pill report" onClick={onReport} title="Báo cáo B7 chờ bạn duyệt">
              <FileText className="ic xs" /> B7 chờ duyệt
            </button>
          )}
          <ProgressPill board={board} colorOf={colorOf} />
        </div>
      )}

      <span className="spacer" />

      {room && (
        <div className="head-actions">
          <Popover
            placement="bottom-end"
            width={220}
            trigger={(p) => (
              <button {...p} className={`icon-btn filter-btn ${hidden.size ? "on" : ""}`} title="Lọc loại tin" aria-label="Lọc loại tin">
                <ListFilter className="ic" />
                {hidden.size > 0 && <span className="count-dot">{MESSAGE_TYPES.length - hidden.size}</span>}
              </button>
            )}
          >
            <MenuLabel>Hiện loại tin</MenuLabel>
            {MESSAGE_TYPES.map((t) => (
              <MenuItem key={t} icon={TYPE_ICON[t]} checked={!hidden.has(t)} keepOpen onSelect={() => toggleType(t)}>
                {TYPE_LABEL[t]}
              </MenuItem>
            ))}
            {hidden.size > 0 && (
              <>
                <MenuSep />
                <MenuItem onSelect={resetTypes}>Hiện tất cả</MenuItem>
              </>
            )}
          </Popover>

          <button className={`avatars ${panel === "people" ? "on" : ""}`} onClick={() => toggle("people")} title="Thành viên" aria-label="Thành viên">
            {agents.slice(0, 3).map((p) => (
              <Avatar key={p.name} name={p.name} color={colorOf(p.name)} size={26} online={p.online} alert={!!p.attention} />
            ))}
            {agents.length === 0 && <span className="muted small">Chưa có agent</span>}
            {alert && <span className="badge-dot" />}
          </button>

          <button
            className={`icon-btn labeled ${panel === "bugs" ? "on" : ""}`}
            onClick={() => toggle("bugs")}
            title={`Bug: ${openBugs} đang mở / ${board.bugs.length}`}
            aria-label="Bảng bug"
          >
            <Bug className="ic" />
            {openBugs > 0 && <span className="count">{openBugs}</span>}
            {(needUser || board.warning) && <span className="badge-dot" />}
          </button>

          <button
            className={`icon-btn ${panel === "terminal" ? "on" : ""}`}
            onClick={() => toggle("terminal")}
            title="Terminal agent chạy ngầm trên hub"
            aria-label="Terminal"
            disabled={!terms.length}
          >
            <SquareTerminal className="ic" />
            {terms.some((t) => t.running) && <span className="run-dot" />}
          </button>
        </div>
      )}
    </header>
  );
}
