import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ArrowUp, EyeOff, Play, RotateCw, Square } from "lucide-react";
import type { TermInfo } from "@tcm/shared";
import type { TermSub } from "../useRoom";

/** Terminal của một agent chạy ngầm trên hub. Ẩn panel chỉ thôi xem, session vẫn chạy. */
export function TerminalPanel({
  name,
  info,
  color,
  openTerm,
  raw,
  onStart,
  onStop,
  onClose,
  autoFocus,
}: {
  name: string;
  info: TermInfo | undefined;
  color: string;
  openTerm: (name: string, sub: TermSub) => () => void;
  raw: (op: Record<string, unknown>) => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
  autoFocus?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [line, setLine] = useState("");

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace',
      scrollback: 3000,
      convertEol: false,
      cursorBlink: true,
      theme: { background: "#0f0f10", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#3a3d41" },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    if (autoFocus) term.focus();
    const size = () => {
      try {
        fit.fit();
      } catch {
        /* panel đang ẩn */
      }
      return { cols: term.cols, rows: term.rows };
    };
    const input = term.onData((data) => raw({ op: "term_input", name, data }));
    const close = openTerm(name, {
      attach: () => raw({ op: "term_attach", name, ...size() }),
      onOp: (op) => {
        if (op.op === "term_snapshot") {
          term.reset();
          if (op.data) term.write(op.data);
        } else if (op.op === "term_data") term.write(op.data);
      },
    });
    // Panel đổi kích thước → báo hub đổi kích thước pseudo-terminal (Claude vẽ lại theo cỡ mới)
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = window.setTimeout(() => raw({ op: "term_resize", name, ...size() }), 120);
    });
    ro.observe(box.current!);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      input.dispose();
      close();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, openTerm, raw]);

  /** Gõ cả dòng vào prompt của agent rồi Enter (gõ tiếng Việt / dán dài dễ hơn gõ thẳng vào xterm) */
  const sendLine = () => {
    const text = line.replace(/[\r\n]+/g, " ").trim();
    if (!text) return;
    raw({ op: "term_input", name, data: text });
    // Enter tách riêng: gõ liền một khối thì ô nhập của Claude có thể coi là dán, không gửi
    setTimeout(() => raw({ op: "term_input", name, data: "\r" }), 150);
    setLine("");
  };

  const running = !!info?.running;
  return (
    <section className="term-panel">
      <header className="term-head">
        <span className="term-dot" style={{ background: running ? color : "var(--muted)" }} />
        <strong>{name}</strong>
        <span className="term-state">
          {running ? `đang chạy${info?.pid ? ` · pid ${info.pid}` : ""}` : info?.exitCode != null ? `đã thoát (${info.exitCode})` : "không chạy"}
        </span>
        <span className="spacer" />
        {info?.canStart && (
          <button
            className="icon-btn xs"
            title={running ? "Tắt session hiện tại và mở session mới (đọc get_summary rồi làm tiếp)" : "Chạy session mới (đọc get_summary rồi làm tiếp)"}
            aria-label={running ? "Chạy lại" : "Chạy"}
            onClick={() => (!running || confirm(`Chạy lại ${name}? Session hiện tại sẽ bị tắt.`)) && onStart()}
          >
            {running ? <RotateCw className="ic" /> : <Play className="ic" />}
          </button>
        )}
        {running && (
          <button className="icon-btn xs" title="Tắt hẳn session" aria-label="Tắt session" onClick={() => confirm(`Tắt session ${name}?`) && onStop()}>
            <Square className="ic" />
          </button>
        )}
        <button className="icon-btn xs" title="Ẩn terminal (session vẫn chạy ngầm)" aria-label="Ẩn terminal" onClick={onClose}>
          <EyeOff className="ic" />
        </button>
      </header>
      <div className="term-box" ref={box} onClick={() => termRef.current?.focus()} />
      <form
        className="term-line"
        onSubmit={(e) => {
          e.preventDefault();
          sendLine();
        }}
      >
        <input
          value={line}
          disabled={!running}
          placeholder={running ? `Gõ vào terminal của ${name}… (Enter gửi)` : "Session không chạy"}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            // Esc: chuyển cho Claude (dừng lượt đang chạy)
            if (e.key === "Escape") raw({ op: "term_input", name, data: "\x1b" });
          }}
        />
        <button className="send-btn sm" disabled={!running || !line.trim()} aria-label="Gửi vào terminal">
          <ArrowUp className="ic" />
        </button>
      </form>
    </section>
  );
}
