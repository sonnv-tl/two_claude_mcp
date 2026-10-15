import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, SquarePen, Users } from "lucide-react";
import type { ChatMessage, MessageType } from "@tcm/shared";
import { useRoom, useRooms } from "./useRoom";
import { useAttentionAlerts, useHashRoom, useLocalStorage, useMediaQuery, useTheme } from "./hooks";
import { colorOf as colorOfIn } from "./lib/colors";
import { errText } from "./lib/format";
import { postJson, roomApi } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { ChatHeader, type Panel } from "./components/ChatHeader";
import { MessageList, type MessageListHandle } from "./components/MessageList";
import { Composer, type ComposerHandle } from "./components/Composer";
import { SidePanel } from "./components/SidePanel";
import { TerminalDock } from "./components/TerminalDock";
import { KickoffDialog } from "./components/KickoffDialog";
import { ReportDialog } from "./components/ReportDialog";
import { NewRoomDialog } from "./components/NewRoomDialog";

type Dialog = null | "new" | "kickoff" | "report";

export function App() {
  const { rooms, reload: reloadRooms } = useRooms();
  const [room, setRoom] = useHashRoom();
  const { messages, participants, conn, send, onDuty, setDuty, board, updateBug, terms, raw, openTerm, startAgent, stopAgent, upload, deleted } =
    useRoom(room);
  const [theme, setTheme] = useTheme();
  const wide = useMediaQuery("(min-width: 900px)");
  const roomy = useMediaQuery("(min-width: 1200px)");
  const [sidebarPref, setSidebarPref] = useLocalStorage("tcm.sidebar", true);
  const [mobileNav, setMobileNav] = useState(false);
  const sidebarShown = wide ? sidebarPref : mobileNav;

  const [panel, setPanel] = useState<Panel>(null);
  const [termOpen, setTermOpen] = useState<string[]>([]);
  const [termMax, setTermMax] = useState(false);
  const [dockWidth, setDockWidth] = useLocalStorage("tcm.dockWidth", 640);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [hidden, setHidden] = useState<Set<MessageType>>(new Set());
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [dragging, setDragging] = useState(false);
  const list = useRef<MessageListHandle>(null);
  const composer = useRef<ComposerHandle>(null);

  const colorOf = useCallback((name: string) => colorOfIn(name, participants), [participants]);
  const info = rooms.find((r) => r.name === room);
  const act = (p: Promise<unknown>) => void p.catch((e) => alert(errText(e)));
  useAttentionAlerts(room, participants);

  // Đổi phòng: đóng panel, bỏ trả lời
  useEffect(() => {
    setReplyTo(null);
    setPanel(null);
    setTermOpen([]);
    setTermMax(false);
    setDialog((d) => (d === "new" ? d : null));
    setMobileNav(false);
  }, [room]);

  // Mặc định mở phòng hoạt động gần nhất
  useEffect(() => {
    if (!room && rooms.length) setRoom(rooms[0].name);
  }, [room, rooms, setRoom]);

  // Có bug chờ phân xử → mở bảng bug (nếu đang không mở panel nào)
  const needUser = board.bugs.some((b) => b.status === "need_user");
  useEffect(() => {
    if (needUser) setPanel((p) => p ?? "bugs");
  }, [needUser]);

  // Phòng đang xem bị xoá (tab này hoặc tab khác) → sang phòng khác
  useEffect(() => {
    if (!deleted || deleted !== room) return;
    reloadRooms();
    const next = rooms.find((r) => r.name !== deleted);
    setRoom(next?.name ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleted]);

  const deleteRoom = async (name: string) => {
    const r = rooms.find((x) => x.name === name);
    const running = name === room ? terms.filter((t) => t.running).map((t) => t.name) : [];
    const ok = confirm(
      `Xoá phòng ${name}?\n\n` +
        `Mất toàn bộ ${r?.messageCount ?? 0} tin nhắn, bảng bug, tiến độ, báo cáo B7, ảnh và thông tin kickoff của phòng.\n` +
        (running.length ? `Session đang chạy ngầm (${running.join(", ")}) sẽ bị tắt.\n` : "Session chạy ngầm của phòng (nếu có) sẽ bị tắt.\n") +
        "\nKhông hoàn tác được.",
    );
    if (!ok) return;
    try {
      await postJson(roomApi(name, "delete"));
      reloadRooms();
      if (name === room) setRoom(rooms.find((x) => x.name !== name)?.name ?? null);
    } catch (e) {
      alert(`Không xoá được phòng: ${errText(e)}`);
    }
  };

  // ---------- terminal ----------
  const toggleTerm = useCallback((name: string, want?: boolean) => {
    setTermOpen((cur) => {
      const on = want ?? !cur.includes(name);
      return on ? (cur.includes(name) ? cur : [...cur, name]) : cur.filter((n) => n !== name);
    });
  }, []);
  /** Mở panel terminal; chưa chọn agent nào thì mở agent đang chạy đầu tiên */
  const showPanel = (p: Panel) => {
    if (p === "terminal" && !termOpen.some((n) => terms.some((t) => t.name === n))) {
      const first = terms.find((t) => t.running) ?? terms[0];
      if (first) setTermOpen([first.name]);
    }
    if (p !== "terminal") setTermMax(false);
    setPanel(p);
  };
  const toggleTermFromPeople = (name: string) => {
    if (panel !== "terminal") {
      setTermOpen((cur) => (cur.includes(name) ? cur : [...cur, name]));
      setPanel("terminal");
    } else toggleTerm(name);
  };

  /** Kéo cạnh trái dock terminal để đổi độ rộng */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = dockWidth;
    const move = (ev: PointerEvent) => setDockWidth(Math.max(380, Math.min(innerWidth - 360, w0 + x0 - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---------- tin nhắn ----------
  const visible = useMemo(() => messages.filter((m) => !hidden.has(m.type)), [messages, hidden]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const toggleType = (t: MessageType) =>
    setHidden((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const onJump = useCallback(
    (id: number) => {
      if (termMax) setTermMax(false);
      setHidden(new Set());
      requestAnimationFrame(() => list.current?.jump(id));
    },
    [termMax],
  );
  const onOpenBugs = useCallback(() => setPanel("bugs"), []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) composer.current?.addFiles(files);
  };

  const disabled = !room || conn !== "open";
  const sideOverlay = !roomy; // màn hẹp: panel nổi đè lên khung chat
  const showTerm = panel === "terminal" && !!room;

  const emptyRoom = (
    <div className="hero">
      <h1>{room ? `Bắt đầu trao đổi trong ${room}` : "Team Hub"}</h1>
      <p className="muted">
        {participants.some((p) => p.kind === "agent")
          ? "Chưa có tin nhắn. Nhắn cho cả phòng, hoặc gõ @dev / @qa ở đầu để gửi riêng."
          : "Phòng chưa có agent. Gửi kickoff để DEV/QA nhận ngay khi vào phòng."}
      </p>
      {room && (
        <button className="btn" onClick={() => setDialog("kickoff")}>
          Soạn kickoff ticket
        </button>
      )}
    </div>
  );

  return (
    <div className={`app ${sidebarShown ? "with-sidebar" : ""}`}>
      {sidebarShown && (
        <>
          {!wide && <div className="scrim" onClick={() => setMobileNav(false)} />}
          <Sidebar
            rooms={rooms}
            room={room}
            onSelect={(r) => {
              setRoom(r);
              setMobileNav(false);
            }}
            onNew={() => setDialog("new")}
            onDelete={(r) => void deleteRoom(r)}
            onCollapse={() => (wide ? setSidebarPref(false) : setMobileNav(false))}
            theme={theme}
            setTheme={setTheme}
          />
        </>
      )}

      <div className="main-area">
        <main
          className={`chat ${showTerm && termMax ? "hidden" : ""}`}
          onDragOver={(e) => {
            if (!room || ![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={onDrop}
        >
          <ChatHeader
            room={room}
            info={info}
            conn={conn}
            onDuty={onDuty}
            board={board}
            participants={participants}
            terms={terms}
            colorOf={colorOf}
            sidebarHidden={!sidebarShown}
            onShowSidebar={() => (wide ? setSidebarPref(true) : setMobileNav(true))}
            onNew={() => setDialog("new")}
            hidden={hidden}
            toggleType={toggleType}
            resetTypes={() => setHidden(new Set())}
            panel={panel}
            setPanel={showPanel}
            onKickoff={() => setDialog("kickoff")}
            onReport={() => setDialog("report")}
            onToggleDuty={() => act(setDuty(!onDuty))}
            onDelete={() => room && void deleteRoom(room)}
          />

          {room ? (
            <>
              <MessageList
                ref={list}
                messages={visible}
                byId={byId}
                colorOf={colorOf}
                onReply={setReplyTo}
                onOpenBugs={onOpenBugs}
                empty={messages.length ? <div className="hero muted">Không có tin nào thuộc loại đang lọc.</div> : emptyRoom}
              />
              <Composer
                key={room}
                ref={composer}
                participants={participants}
                disabled={disabled}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                upload={upload}
                placeholder={`Nhắn cho team trong ${room}…`}
                onSend={async (m) => {
                  await send(m);
                  setReplyTo(null);
                  list.current?.toBottom();
                }}
              />
            </>
          ) : (
            <div className="welcome">
              <div className="hero">
                <span className="hero-logo">
                  <Users className="ic" />
                </span>
                <h1>Bắt đầu ticket mới</h1>
                <p className="muted">Nhập mã ticket: hub chạy ngầm DEV + QA trong repo rồi gửi kickoff cho cả hai.</p>
                <button className="btn primary lg" onClick={() => setDialog("new")}>
                  <SquarePen className="ic" /> Phòng mới
                </button>
              </div>
            </div>
          )}

          {dragging && (
            <div className="drop-overlay">
              <ImagePlus className="ic lg" />
              Thả ảnh để đính kèm vào tin nhắn
            </div>
          )}
        </main>

        {room && (panel === "people" || panel === "bugs") && (
          <>
            {sideOverlay && <div className="scrim panel-scrim" onClick={() => setPanel(null)} />}
            <SidePanel
              tab={panel}
              setTab={(t) => setPanel(t)}
              onClose={() => setPanel(null)}
              board={board}
              participants={participants}
              terms={terms}
              colorOf={colorOf}
              openTerms={[]}
              onToggleTerm={toggleTermFromPeople}
              onJump={onJump}
              onUpdateBug={updateBug}
              disabled={disabled}
            />
          </>
        )}

        {showTerm && (
          <div className={`dock-wrap ${termMax ? "max" : ""}`} style={termMax || !wide ? undefined : { width: dockWidth }}>
            {!termMax && wide && <div className="resize-handle" onPointerDown={startResize} title="Kéo để đổi độ rộng" />}
            <TerminalDock
              room={room!}
              terms={terms}
              open={termOpen}
              toggle={toggleTerm}
              onClose={() => (setPanel(null), setTermMax(false))}
              maximized={termMax}
              setMaximized={setTermMax}
              colorOf={colorOf}
              openTerm={openTerm}
              raw={raw}
              onStart={(n) => act(startAgent(n))}
              onStop={(n) => act(stopAgent(n))}
              connected={conn === "open"}
            />
          </div>
        )}
      </div>

      {dialog === "new" && (
        <NewRoomDialog
          rooms={rooms}
          onClose={() => setDialog(null)}
          onCreated={(r) => {
            setDialog(null);
            reloadRooms();
            setRoom(r);
          }}
        />
      )}
      {dialog === "kickoff" && room && <KickoffDialog room={room} onClose={() => setDialog(null)} />}
      {dialog === "report" && room && <ReportDialog room={room} board={board} send={send} onClose={() => setDialog(null)} />}
    </div>
  );
}
