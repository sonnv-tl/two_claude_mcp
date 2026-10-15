/** POST JSON tới hub, lỗi HTTP → Error với thông báo của hub */
export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export const roomApi = (room: string, sub: string) => `/api/rooms/${encodeURIComponent(room)}/${sub}`;

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}
