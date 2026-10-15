/** Trích dẫn ngắn: bỏ ký tự markdown, ảnh thành "[ảnh]" */
export function plain(md: string) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[ảnh]")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const timeHM = (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { hour12: false, hour: "2-digit", minute: "2-digit" });

export const dateTime = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour12: false });

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Nhãn ngày cho dải phân cách trong hội thoại */
export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (dayKey(d) === dayKey(today)) return "Hôm nay";
  if (dayKey(d) === dayKey(yest)) return "Hôm qua";
  const s = d.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const sameDay = (a: string, b: string) => dayKey(new Date(a)) === dayKey(new Date(b));

/** "5 phút", "3 giờ", "2 ngày" trước */
export function ago(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86_400) return `${Math.floor(s / 3600)} giờ`;
  return `${Math.floor(s / 86_400)} ngày`;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
