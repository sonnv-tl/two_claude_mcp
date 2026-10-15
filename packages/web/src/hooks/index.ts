import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "@tcm/shared";

/** Phòng đang xem nằm trên URL: #/TLPORTAL-123 */
export function useHashRoom(): [string | null, (r: string | null) => void] {
  const read = () => decodeURIComponent(location.hash.replace(/^#\/?/, "")) || null;
  const [room, setRoom] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setRoom(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: string | null) => {
    if (r) location.hash = `/${encodeURIComponent(r)}`;
    else {
      history.replaceState(null, "", location.pathname);
      setRoom(null);
    }
  }, []);
  return [room, go];
}

/** State lưu localStorage (lỗi đọc/ghi thì dùng giá trị mặc định) */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((cur: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* chế độ riêng tư */
    }
  }, [key, value]);
  return [value, setValue];
}

export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export type Theme = "system" | "light" | "dark";

/** Giao diện sáng / tối / theo hệ thống: đặt data-theme trên <html> */
export function useTheme() {
  const [theme, setTheme] = useLocalStorage<Theme>("tcm.theme", "system");
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

/** Re-render định kỳ (thời gian tương đối tự cập nhật) */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Đóng khi bấm ra ngoài phần tử / nhấn Esc */
export function useDismiss(open: boolean, onClose: () => void, refs: React.RefObject<HTMLElement | null>[]) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      cb.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cb.current();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Âm thanh + thông báo desktop khi agent cần user ở terminal, hoặc hỏi user */
export function useAttentionAlerts(room: string | null, participants: Participant[]) {
  const prev = useRef(new Map<string, string | null>());
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  }, []);
  useEffect(() => {
    prev.current = new Map();
  }, [room]);
  useEffect(() => {
    for (const p of participants) {
      const before = prev.current.get(p.name);
      if (p.attention && p.attention !== before && prev.current.has(p.name)) alertUser(`${p.name}: ${p.attention}`);
      prev.current.set(p.name, p.attention);
    }
  }, [participants]);
}

function alertUser(text: string) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch {
    /* trình duyệt chặn âm thanh khi chưa tương tác */
  }
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification("Team Hub", { body: text });
  }
}
