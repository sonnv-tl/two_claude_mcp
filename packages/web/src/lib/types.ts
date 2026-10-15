import { ArrowRightLeft, Bug, CircleHelp, FileText, Info, ListChecks, MessageSquare, TriangleAlert, type LucideIcon } from "lucide-react";
import type { MessageType } from "@tcm/shared";

export const HUMAN = "user";

export const TYPE_LABEL: Record<MessageType, string> = {
  chat: "chat",
  question: "câu hỏi",
  ac_deviation: "lệch AC",
  test_case: "test case",
  bug_report: "bug",
  handoff: "bàn giao",
  report: "báo cáo",
  system: "hệ thống",
};

export const TYPE_ICON: Record<MessageType, LucideIcon> = {
  chat: MessageSquare,
  question: CircleHelp,
  ac_deviation: TriangleAlert,
  test_case: ListChecks,
  bug_report: Bug,
  handoff: ArrowRightLeft,
  report: FileText,
  system: Info,
};

/** Loại tin user gửi được từ web */
export const USER_TYPES: MessageType[] = ["chat", "question", "handoff"];
