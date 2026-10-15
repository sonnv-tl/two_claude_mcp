import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";
import { useDismiss } from "../../hooks";

type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

interface TriggerProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": true;
}

const CloseCtx = createContext<() => void>(() => {});

/** Popover gắn vào nút bấm, vẽ qua portal (không bị overflow của sidebar / header cắt) */
export function Popover({
  trigger,
  children,
  placement = "bottom-start",
  className = "",
  width,
}: {
  trigger: (p: TriggerProps, open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  className?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = () => setOpen(false);
  useDismiss(open, close, [btn, pop]);

  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const b = btn.current?.getBoundingClientRect();
      const p = pop.current?.getBoundingClientRect();
      if (!b || !p) return;
      const gap = 6;
      let left = placement.endsWith("end") ? b.right - p.width : b.left;
      let top = placement.startsWith("top") ? b.top - p.height - gap : b.bottom + gap;
      if (top + p.height > innerHeight - 8) top = Math.max(8, b.top - p.height - gap);
      if (top < 8) top = Math.min(innerHeight - p.height - 8, b.bottom + gap);
      left = Math.max(8, Math.min(left, innerWidth - p.width - 8));
      setPos({ left, top });
    };
    place();
    const onResize = () => close();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, placement]);

  return (
    <>
      {trigger({ ref: btn, onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": true }, open)}
      {open &&
        createPortal(
          <div
            ref={pop}
            className={`popover ${className}`}
            role="menu"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, visibility: pos ? "visible" : "hidden" }}
          >
            <CloseCtx.Provider value={close}>{typeof children === "function" ? children(close) : children}</CloseCtx.Provider>
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onSelect,
  danger,
  checked,
  disabled,
  hint,
  keepOpen,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  keepOpen?: boolean;
}) {
  const close = useContext(CloseCtx);
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item ${danger ? "danger" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (!keepOpen) close();
        onSelect();
      }}
    >
      {Icon ? <Icon className="ic" /> : <span className="ic" />}
      <span className="menu-label">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {checked !== undefined && <Check className={`ic check ${checked ? "" : "invisible"}`} />}
    </button>
  );
}

export const MenuSep = () => <div className="menu-sep" role="separator" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-title">{children}</div>;
