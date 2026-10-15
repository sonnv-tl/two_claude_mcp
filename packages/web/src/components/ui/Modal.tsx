import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, type LucideIcon } from "lucide-react";

/** Hộp thoại giữa màn hình. Esc / bấm nền để đóng (closeOnEsc=false cho terminal). */
export function Modal({
  title,
  icon: Icon,
  badge,
  onClose,
  children,
  footer,
  size = "md",
  closeOnEsc = true,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  closeOnEsc?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeOnEsc]);
  useEffect(() => {
    // Focus ô nhập đầu tiên
    const el = box.current?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])");
    el?.focus();
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`modal modal-${size}`} role="dialog" aria-modal="true">
        <header className="modal-head">
          {Icon && <Icon className="ic modal-icon" />}
          <h2>{title}</h2>
          {badge}
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Đóng" title="Đóng">
            <X className="ic" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
