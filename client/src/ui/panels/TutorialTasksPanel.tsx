import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { apiClient, type TutorialTaskInfo } from "../services/api-client";
import { centeredWindowStyle, darkGlassSubtlePanelStyle, useFloatingWindowZIndex } from "../components/panel-styles";

export function TutorialTasksPanel({
  open,
  alwaysVisible = false,
  onClose,
  onExpand,
}: {
  open: boolean;
  alwaysVisible?: boolean;
  onClose: () => void;
  onExpand?: () => void;
}) {
  const [task, setTask] = useState<TutorialTaskInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);
  const visible = open || alwaysVisible;

  const refresh = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    setError("");
    try {
      const response = await apiClient.getTutorialTask();
      setTask(response.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [visible]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  if (!visible) return null;

  const progress = task?.progress ?? { completed: 0, total: 0, percent: 0 };
  const nextObjective = task?.objectives.find((objective) => !objective.completed) ?? task?.objectives[0] ?? null;

  if (!open) {
    return (
      <aside style={hudStyle} onClick={onExpand} role={onExpand ? "button" : undefined} title={onExpand ? "查看全部任务" : undefined}>
        <div style={hudHeaderStyle}>
          <span>任务</span>
          <strong>{progress.completed}/{progress.total}</strong>
        </div>
        {loading && !task && <div style={hudLoadingStyle}>加载中...</div>}
        {error && <div style={hudErrorStyle}>{error}</div>}
        {task && nextObjective && (
          <>
            <div style={hudObjectiveTitleStyle}>{nextObjective.completed ? "新手引导已完成" : nextObjective.label}</div>
            <div style={hudObjectiveDescriptionStyle}>
              {nextObjective.completed ? "所有当前目标都已完成。" : nextObjective.description}
            </div>
            {nextObjective.rewards.length > 0 && (
              <div style={hudRewardStyle}>
                奖励 {formatRewards(nextObjective.rewards)}
              </div>
            )}
            <div style={hudProgressRowStyle}>
              <span style={hudProgressCountStyle}>进度 {nextObjective.currentCount}/{nextObjective.requiredCount}</span>
              <div style={hudProgressTrackStyle}>
                <div
                  style={{
                    ...hudProgressFillStyle,
                    width: `${Math.min(100, Math.round((nextObjective.currentCount / Math.max(1, nextObjective.requiredCount)) * 100))}%`,
                  }}
                />
              </div>
            </div>
          </>
        )}
      </aside>
    );
  }

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>任务</div>
          <div style={subtitleStyle}>
            {task?.title ?? "新手引导"} · {progress.completed}/{progress.total}
          </div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭任务">×</button>
      </header>

      <section style={summaryStyle}>
        <div style={progressMetaStyle}>
          <span>{task?.description ?? "加载任务中..."}</span>
          <strong>{progress.percent}%</strong>
        </div>
        <div style={progressTrackStyle}>
          <div style={{ ...progressFillStyle, width: `${progress.percent}%` }} />
        </div>
      </section>

      {loading && !task && <div style={emptyStyle}>加载中...</div>}
      {error && <div style={errorStyle}>{error}</div>}

      {task && (
        <div className="custom-scrollbar" style={listStyle}>
          {task.objectives.map((objective) => (
            <div key={objective.id} style={objectiveStyle(objective.completed)}>
              <div style={objectiveStatusStyle(objective.completed)}>
                {objective.completed ? "✓" : objective.currentCount}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={objectiveTitleStyle}>{objective.label}</div>
                <div style={objectiveDescriptionStyle}>{objective.description}</div>
                {objective.rewards.length > 0 && (
                  <div style={objectiveRewardStyle(objective.completed)}>
                    奖励 {formatRewards(objective.rewards)}
                    {objective.rewards.every((reward) => reward.claimed) ? " · 已发放" : ""}
                  </div>
                )}
              </div>
              <div style={objectiveCountStyle}>
                {objective.currentCount}/{objective.requiredCount}
              </div>
            </div>
          ))}
        </div>
      )}

      {task?.status === "completed" && (
        <div style={doneStyle}>新手引导已完成。</div>
      )}
    </aside>
  );
}

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(620, 840),
};

const hudStyle: CSSProperties = {
  position: "fixed",
  right: 24,
  top: 154,
  width: 330,
  maxWidth: "calc(100vw - 48px)",
  zIndex: 1550,
  pointerEvents: "auto",
  padding: "12px 14px",
  borderRadius: 16,
  ...darkGlassSubtlePanelStyle,
  color: "#eef4ff",
  fontFamily: "system-ui, sans-serif",
  cursor: "pointer",
};

const hudHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 8,
  fontSize: 12,
  color: "rgba(238,244,255,0.66)",
  fontWeight: 900,
};

const hudLoadingStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(238,244,255,0.58)",
};

const hudErrorStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: "#ffb8b8",
};

const hudObjectiveTitleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.3,
  fontWeight: 900,
  color: "#fff",
};

const hudObjectiveDescriptionStyle: CSSProperties = {
  marginTop: 5,
  fontSize: 12,
  lineHeight: 1.45,
  color: "rgba(238,244,255,0.64)",
};

const hudRewardStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  marginTop: 8,
  padding: "4px 8px",
  borderRadius: 999,
  background: "rgba(255,216,107,0.12)",
  border: "1px solid rgba(255,216,107,0.2)",
  color: "#ffe28a",
  fontSize: 11,
  fontWeight: 900,
};

const hudProgressRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "62px minmax(0, 1fr)",
  alignItems: "center",
  gap: 9,
  marginTop: 10,
  fontSize: 11,
  color: "rgba(238,244,255,0.7)",
  fontWeight: 800,
};

const hudProgressCountStyle: CSSProperties = {
  display: "inline-block",
  minWidth: 58,
};

const hudProgressTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 999,
  overflow: "hidden",
  background: "rgba(255,255,255,0.1)",
};

const hudProgressFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(90deg, rgba(56,189,248,0.96), rgba(116,185,255,0.96))",
  transition: "width 0.24s ease",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 14px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const titleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
};

const subtitleStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  color: "rgba(238,244,255,0.62)",
};

const closeButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.07)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 20,
  lineHeight: "26px",
};

const summaryStyle: CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const progressMetaStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 12,
  color: "rgba(238,244,255,0.72)",
};

const progressTrackStyle: CSSProperties = {
  marginTop: 10,
  height: 8,
  borderRadius: 999,
  overflow: "hidden",
  background: "rgba(255,255,255,0.08)",
};

const progressFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(90deg, rgba(56,189,248,0.95), rgba(116,185,255,0.95))",
  transition: "width 0.24s ease",
};

const listStyle: CSSProperties = {
  maxHeight: "min(520px, calc(100vh - 210px))",
  overflowY: "auto",
  padding: 12,
};

function objectiveStyle(completed: boolean): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "30px minmax(0, 1fr) auto",
    gap: 10,
    alignItems: "center",
    padding: "10px 11px",
    marginBottom: 8,
    borderRadius: 12,
    border: completed ? "1px solid rgba(90,220,150,0.28)" : "1px solid rgba(255,255,255,0.1)",
    background: completed ? "rgba(90,220,150,0.08)" : "rgba(255,255,255,0.045)",
  };
}

function objectiveStatusStyle(completed: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    background: completed ? "rgba(90,220,150,0.22)" : "rgba(116,185,255,0.15)",
    color: completed ? "#9ff0bc" : "#b8dcff",
    fontSize: 13,
    fontWeight: 900,
  };
}

const objectiveTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#fff",
};

const objectiveDescriptionStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  lineHeight: 1.45,
  color: "rgba(238,244,255,0.58)",
};

function objectiveRewardStyle(completed: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    marginTop: 6,
    padding: "3px 7px",
    borderRadius: 999,
    background: completed ? "rgba(255,216,107,0.13)" : "rgba(255,216,107,0.075)",
    border: completed ? "1px solid rgba(255,216,107,0.28)" : "1px solid rgba(255,216,107,0.16)",
    color: "#ffe28a",
    fontSize: 10,
    fontWeight: 900,
  };
}

const objectiveCountStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(238,244,255,0.58)",
  fontWeight: 800,
};

const emptyStyle: CSSProperties = {
  padding: 18,
  color: "rgba(238,244,255,0.58)",
  fontSize: 12,
};

const errorStyle: CSSProperties = {
  margin: 12,
  padding: 10,
  borderRadius: 10,
  background: "rgba(255,118,117,0.1)",
  border: "1px solid rgba(255,118,117,0.24)",
  color: "#ffb8b8",
  fontSize: 12,
};

const doneStyle: CSSProperties = {
  margin: "0 12px 12px",
  padding: 10,
  borderRadius: 10,
  background: "rgba(90,220,150,0.1)",
  border: "1px solid rgba(90,220,150,0.24)",
  color: "#baf7ce",
  fontSize: 12,
};

function formatRewards(rewards: TutorialTaskInfo["rewards"]): string {
  return rewards
    .map((reward) => {
      const quantity = typeof reward.quantity === "number" ? ` +${reward.quantity}` : "";
      if (reward.kind === "resource") return `资源${quantity}`;
      return `${reward.label}${quantity}`;
    })
    .join("，");
}
