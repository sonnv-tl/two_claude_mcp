import { ChevronDown, Route } from "lucide-react";
import { STEPS, STEP_LABEL, fmtDuration, stepSummary, type Board } from "@tcm/shared";
import { Popover } from "./ui/Popover";
import { useTick } from "../hooks";

/** Viên tiến độ B1–B7 trên header; bấm xem chi tiết từng bước */
export function ProgressPill({ board, colorOf }: { board: Board; colorOf: (name: string) => string }) {
  useTick();
  const sum = stepSummary(board.steps);
  if (!sum.size) return null;
  const agents = [...sum.entries()];
  const steps = new Set(agents.map(([, s]) => s.current));
  const label =
    steps.size === 1
      ? `${agents[0][1].current} · ${STEP_LABEL[agents[0][1].current]}`
      : agents.map(([n, s]) => `${n} ${s.current}`).join(" · ");
  const maxIdx = Math.max(...agents.map(([, s]) => STEPS.indexOf(s.current)));

  return (
    <Popover
      placement="bottom-start"
      width={320}
      trigger={(p, open) => (
        <button {...p} className={`pill progress-pill ${open ? "open" : ""}`} title="Tiến độ ticket">
          <span className="progress-bar" aria-hidden>
            {STEPS.map((st, i) => (
              <i key={st} className={i < maxIdx ? "done" : i === maxIdx ? "cur" : ""} />
            ))}
          </span>
          <span className="pill-text">{label}</span>
          <ChevronDown className="ic xs" />
        </button>
      )}
    >
      <div className="steps">
        <div className="menu-title">
          <Route className="ic" /> Tiến độ B1–B7
        </div>
        {STEPS.map((st) => {
          const here = agents.filter(([, s]) => s.current === st);
          const passed = agents.every(([, s]) => STEPS.indexOf(s.current) > STEPS.indexOf(st));
          const spent = agents.filter(([, s]) => s.spent[st]);
          return (
            <div key={st} className={`step-row ${here.length ? "current" : ""} ${passed ? "done" : ""}`}>
              <span className="step-dot">{st}</span>
              <div className="step-info">
                <div className="step-name">
                  {STEP_LABEL[st]}
                  {here.map(([name]) => (
                    <span key={name} className="who" style={{ background: colorOf(name) }}>
                      {name}
                    </span>
                  ))}
                </div>
                {spent.length > 0 && <div className="small muted">{spent.map(([name, s]) => `${name} ${fmtDuration(s.spent[st]!)}`).join(" · ")}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
