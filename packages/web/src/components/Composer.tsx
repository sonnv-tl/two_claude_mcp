import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown, CornerUpLeft, ImagePlus, LoaderCircle, Plus, Users, X } from "lucide-react";
import { ATTACHMENT_EXT, BROADCAST, MAX_ATTACHMENT_BYTES, type ChatMessage, type MessageType, type Participant } from "@tcm/shared";
import type { OutgoingMessage } from "../useRoom";
import { Popover, MenuItem, MenuLabel, MenuSep } from "./ui/Popover";
import { HUMAN, TYPE_ICON, TYPE_LABEL, USER_TYPES } from "../lib/types";
import { errText, plain } from "../lib/format";
import { stripLeadingEmoji } from "../lib/emoji";

interface Attachment {
  id: number;
  name: string;
  preview: string;
  url?: string;
  error?: string;
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
}

const MIME_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

function fileToBase64(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => fail(r.error ?? new Error("Không đọc được file"));
    r.readAsDataURL(f);
  });
}

let seq = 0;

/** Khung soạn tin kiểu ChatGPT: chọn người nhận, loại tin, đính kèm ảnh (dán / kéo thả / chọn file) */
export const Composer = forwardRef<
  ComposerHandle,
  {
    participants: Participant[];
    disabled: boolean;
    replyTo: ChatMessage | null;
    onCancelReply: () => void;
    onSend: (m: OutgoingMessage) => Promise<void>;
    upload: (filename: string, data: string) => Promise<{ url: string }>;
    placeholder?: string;
  }
>(function Composer({ participants, disabled, replyTo, onCancelReply, onSend, upload, placeholder }, ref) {
  const [text, setText] = useState("");
  const [to, setTo] = useState(BROADCAST);
  const [type, setType] = useState<MessageType>("chat");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recipients = participants.filter((p) => p.name !== HUMAN);
  const uploading = atts.some((a) => !a.url && !a.error);

  // Bấm "trả lời" một tin → gửi lại cho người đó
  useEffect(() => {
    if (replyTo && replyTo.from !== HUMAN && replyTo.from !== "hub") setTo(replyTo.from);
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  // Ô nhập tự giãn theo nội dung
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Giải phóng ảnh xem trước
  useEffect(() => () => atts.forEach((a) => URL.revokeObjectURL(a.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (files: File[]) => {
    for (const f of files) {
      const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] ?? MIME_EXT[f.type] ?? "").toLowerCase();
      const name = /\.[a-z0-9]+$/i.test(f.name) ? f.name : `anh-${Date.now().toString(36)}${ext}`;
      const att: Attachment = { id: ++seq, name, preview: URL.createObjectURL(f) };
      if (!(ATTACHMENT_EXT as readonly string[]).includes(ext)) att.error = `Chỉ nhận ảnh ${ATTACHMENT_EXT.join(", ")}`;
      else if (f.size > MAX_ATTACHMENT_BYTES) att.error = `Ảnh quá lớn (> ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`;
      setAtts((cur) => [...cur, att]);
      if (att.error) continue;
      fileToBase64(f)
        .then((data) => upload(name, data))
        .then(({ url }) => setAtts((cur) => cur.map((a) => (a.id === att.id ? { ...a, url } : a))))
        .catch((e) => setAtts((cur) => cur.map((a) => (a.id === att.id ? { ...a, error: errText(e) } : a))));
    }
    input.current?.focus();
  };
  const removeAtt = (id: number) =>
    setAtts((cur) => {
      const a = cur.find((x) => x.id === id);
      if (a) URL.revokeObjectURL(a.preview);
      return cur.filter((x) => x.id !== id);
    });

  useImperativeHandle(ref, () => ({ addFiles, focus: () => input.current?.focus() }));

  const ready = atts.filter((a) => a.url);
  const canSend = !disabled && !busy && !uploading && (!!text.trim() || ready.length > 0);

  const submit = async () => {
    if (!canSend) return;
    let content = text.trim();
    let target = to;
    // "@qa nội dung" ở đầu tin → đổi người nhận
    const m = content.match(/^@([\w.-]+)\s+([\s\S]+)$/);
    if (m && (m[1] === "all" || recipients.some((p) => p.name === m[1]))) {
      target = m[1] === "all" ? BROADCAST : m[1];
      content = m[2].trim();
    }
    const imgs = ready.map((a, i) => `![${a.name.replace(/[[\]]/g, "") || `ảnh ${i + 1}`}](${a.url})`).join("\n");
    content = [content, imgs].filter(Boolean).join("\n\n");
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await onSend({ to: target, content, type, replyTo: replyTo?.id ?? null });
      setText("");
      setType("chat");
      atts.forEach((a) => URL.revokeObjectURL(a.preview));
      setAtts([]);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const TypeIcon = TYPE_ICON[type];
  const toLabel = to === BROADCAST ? "Cả phòng" : `@${to}`;

  return (
    <div className="composer-wrap">
      <div className={`composer ${disabled ? "disabled" : ""}`}>
        {replyTo && (
          <div className="composer-reply">
            <CornerUpLeft className="ic xs" />
            <span>
              Trả lời <strong>{replyTo.from}</strong>: {plain(stripLeadingEmoji(replyTo.content)).slice(0, 110)}
            </span>
            <button className="icon-btn xs" onClick={onCancelReply} aria-label="Huỷ trả lời">
              <X className="ic" />
            </button>
          </div>
        )}
        {atts.length > 0 && (
          <div className="att-row">
            {atts.map((a) => (
              <div key={a.id} className={`att ${a.error ? "err" : ""}`} title={a.error ?? a.name}>
                <img src={a.preview} alt={a.name} />
                {!a.url && !a.error && (
                  <span className="att-busy">
                    <LoaderCircle className="ic spin" />
                  </span>
                )}
                {a.error && <span className="att-err">lỗi</span>}
                <button className="att-x" onClick={() => removeAtt(a.id)} aria-label={`Bỏ ${a.name}`}>
                  <X className="ic" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={disabled ? "Chưa kết nối hub…" : (placeholder ?? "Nhắn cho team…")}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bar">
          <Popover
            placement="top-start"
            trigger={(p) => (
              <button {...p} className="icon-btn round" disabled={disabled} title="Đính kèm ảnh, loại tin" aria-label="Thêm">
                <Plus className="ic" />
              </button>
            )}
          >
            <MenuItem icon={ImagePlus} onSelect={() => fileInput.current?.click()} hint="hoặc dán / kéo thả">
              Đính kèm ảnh
            </MenuItem>
            <MenuSep />
            <MenuLabel>Loại tin</MenuLabel>
            {USER_TYPES.map((t) => (
              <MenuItem key={t} icon={TYPE_ICON[t]} checked={type === t} onSelect={() => setType(t)}>
                {TYPE_LABEL[t]}
              </MenuItem>
            ))}
          </Popover>
          <input
            ref={fileInput}
            type="file"
            accept={ATTACHMENT_EXT.join(",")}
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Popover
            placement="top-start"
            trigger={(p) => (
              <button {...p} className={`chip-btn ${to !== BROADCAST ? "on" : ""}`} disabled={disabled} title="Người nhận">
                {to === BROADCAST ? <Users className="ic xs" /> : <AtSign className="ic xs" />}
                {toLabel}
                <ChevronDown className="ic xs" />
              </button>
            )}
          >
            <MenuLabel>Gửi tới</MenuLabel>
            <MenuItem icon={Users} checked={to === BROADCAST} onSelect={() => setTo(BROADCAST)}>
              Cả phòng (@all)
            </MenuItem>
            {recipients.map((p) => (
              <MenuItem key={p.name} icon={AtSign} checked={to === p.name} onSelect={() => setTo(p.name)} hint={p.online ? undefined : "offline"}>
                {p.name}
              </MenuItem>
            ))}
          </Popover>
          {type !== "chat" && (
            <button className="chip-btn on" onClick={() => setType("chat")} title="Bỏ loại tin (về chat thường)">
              <TypeIcon className="ic xs" />
              {TYPE_LABEL[type]}
              <X className="ic xs" />
            </button>
          )}
          <span className="spacer" />
          <button className="send-btn" onClick={() => void submit()} disabled={!canSend} aria-label="Gửi" title="Gửi (Enter)">
            {busy || uploading ? <LoaderCircle className="ic spin" /> : <ArrowUp className="ic" />}
          </button>
        </div>
      </div>
      {error && <div className="form-error composer-error">{error}</div>}
      <div className="composer-hint">Enter gửi · Shift+Enter xuống dòng · gõ @qa ở đầu để gửi riêng · dán hoặc kéo thả ảnh để đính kèm</div>
    </div>
  );
});
