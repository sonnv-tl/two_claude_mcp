import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Participant, RoomInfo, ServerOp } from "@tcm/shared";

export type ConnState = "connecting" | "open" | "closed";

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** Theo dõi một phòng ở chế độ viewer: lịch sử + tin realtime + participants. */
export function useRoom(room: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const lastId = useRef(0);

  useEffect(() => {
    setMessages([]);
    setParticipants([]);
    lastId.current = 0;
    if (!room) return;

    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: number | undefined;

    const merge = (incoming: ChatMessage[]) => {
      if (!incoming.length) return;
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id, m]));
        incoming.forEach((m) => map.set(m.id, m));
        return [...map.values()].sort((a, b) => a.id - b.id);
      });
      lastId.current = Math.max(lastId.current, ...incoming.map((m) => m.id));
    };

    const connect = () => {
      setConn("connecting");
      ws = new WebSocket(wsUrl());
      ws.onopen = async () => {
        ws!.send(JSON.stringify({ op: "hello", kind: "viewer", room }));
        // Tải lịch sử (lần đầu: 200 tin gần nhất; reconnect: tin mới hơn lastId)
        const q = lastId.current ? `sinceId=${lastId.current}&limit=500` : "limit=200";
        const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/messages?${q}`);
        merge(await res.json());
        setConn("open");
      };
      ws.onmessage = (ev) => {
        const op = JSON.parse(ev.data) as ServerOp;
        if (op.op === "message") merge([op.message]);
        else if (op.op === "participants") setParticipants(op.participants);
      };
      ws.onclose = () => {
        setConn("closed");
        if (!stopped) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [room]);

  return { messages, participants, conn };
}

export function useRooms(intervalMs = 5000) {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/rooms")
        .then((r) => r.json())
        .then((d) => alive && setRooms(d))
        .catch(() => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return rooms;
}
