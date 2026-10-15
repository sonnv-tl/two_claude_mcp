import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TermInfo } from "@tcm/shared";
import type { TermSub } from "./useRoom";

/** Terminal của một agent chạy ngầm trên hub. Đóng panel chỉ thôi xem, session vẫn chạy. */
export function TerminalPanel({
  name,
  info,
  color,
  openTerm,
  raw,
  onStart,
  onStop,
  onClose,
}: {
  name: string;
  info: TermInfo | undefined;
  color: string;
  openTerm: (name: string, sub: TermSub) => () => void;
  raw: (op: Record<string, unknown>) => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace",
      scrollback: 3000,
      convertEol: false,
      theme: { background: "#14161a" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
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
      t = window.setTimeout(() => {
        const s = size();
        raw({ op: "term_resize", name, ...s });
      }, 120);
    });
    ro.observe(box.current!);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      input.dispose();
      close();
      term.dispose();
    };
  }, [name, openTerm, raw]);

  const running = !!info?.running;
  return (
    <section className="term-panel">
      <header className="term-head small">
        <strong style={{ color }}>{name}</strong>
        <span className={`chip ${running ? "busy" : "idle"}`}>
          {running ? `đang chạy${info?.pid ? ` · pid ${info.pid}` : ""}` : info?.exitCode != null ? `đã thoát (${info.exitCode})` : "không chạy"}
        </span>
        <span className="spacer" />
        {info?.canStart && (
          <button
            className="link small"
            title={running ? "Tắt session hiện tại và mở session mới (đọc get_summary rồi làm tiếp)" : "Chạy session mới (đọc get_summary rồi làm tiếp)"}
            onClick={() => (!running || confirm(`Chạy lại ${name}? Session hiện tại sẽ bị tắt.`)) && onStart()}
          >
            {running ? "↻ chạy lại" : "▶ chạy"}
          </button>
        )}
        {running && (
          <button className="link small" title="Tắt hẳn session" onClick={() => confirm(`Tắt session ${name}?`) && onStop()}>
            ■ tắt
          </button>
        )}
        <button className="link small" title="Ẩn terminal (session vẫn chạy ngầm)" onClick={onClose}>
          ✕ ẩn
        </button>
      </header>
      <div className="term-box" ref={box} />
    </section>
  );
}
