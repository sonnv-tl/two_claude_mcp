import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, MessageType, Participant, RoomInfo, ServerOp } from "@tcm/shared";

export interface OutgoingMessage {
  to: string;
  content: string;
  type?: MessageType;
  replyTo?: number | null;
}

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
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, { resolve: (m: ChatMessage) => void; reject: (e: Error) => void }>());
  const seq = useRef(0);

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
      wsRef.current = ws;
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
        else if (op.op === "result" || op.op === "error") {
          const p = op.reqId ? pending.current.get(op.reqId) : undefined;
          if (!p) return;
          pending.current.delete(op.reqId!);
          if (op.op === "result") p.resolve(op.data as ChatMessage);
          else p.reject(new Error(op.error));
        }
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

  /** Gửi tin dưới tên "user" */
  const send = useCallback((m: OutgoingMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chưa kết nối hub"));
    const reqId = `w${++seq.current}`;
    return new Promise<ChatMessage>((resolve, reject) => {
      pending.current.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ op: "send", reqId, ...m }));
      setTimeout(() => {
        if (pending.current.delete(reqId)) reject(new Error("Hub không phản hồi"));
      }, 10_000);
    });
  }, []);

  return { messages, participants, conn, send };
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
