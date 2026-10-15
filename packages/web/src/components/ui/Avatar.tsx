import { Bot, User } from "lucide-react";
import { initials } from "../../lib/colors";

/** Avatar tròn: user / hub dùng icon, agent dùng chữ viết tắt trên nền màu vai trò */
export function Avatar({ name, color, size = 28, online, alert }: { name: string; color: string; size?: number; online?: boolean; alert?: boolean }) {
  const icon = name === "user" ? <User className="ic" /> : name === "hub" ? <Bot className="ic" /> : null;
  return (
    <span
      className={`avatar ${alert ? "alert" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.38, ["--av" as string]: color }}
      title={name}
      aria-hidden
    >
      {icon ?? initials(name)}
      {online !== undefined && <span className={`presence ${online ? "on" : ""}`} />}
    </span>
  );
}
