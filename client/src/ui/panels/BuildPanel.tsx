import { useEffect, useState, useRef } from "react";
import type { CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import type { BuildState, BuildCosts, BuildJobStatus } from "../../types/api";

type TabKey = "character" | "map";
type MapDirection = "north" | "south" | "east" | "west";

const RESOURCE_ICONS: Record<string, string> = {
  wood: "🪵",
  stone: "🪨",
  iron: "⚙️",
  food: "🍞",
  gold: "💰",
  crystal: "💎",
  fiber: "🧵",
  herb: "🌿",
};

const DIRECTION_LABELS: Record<MapDirection, { label: string; icon: string; dirLabel: string }> = {
  north: { label: "向北扩展", icon: "⬆️", dirLabel: "北" },
  south: { label: "向南扩展", icon: "⬇️", dirLabel: "南" },
  east: { label: "向东扩展", icon: "➡️", dirLabel: "东" },
  west: { label: "向西扩展", icon: "⬅️", dirLabel: "西" },
};

export function BuildPanel({
  open,
  onClose,
  buildState,
  onBuildStateChange,
}: {
  open: boolean;
  onClose: () => void;
  buildState: BuildState | null;
  onBuildStateChange?: (state: BuildState) => void;
}) {
  const [tab, setTab] = useState<TabKey>("character");
  const [characterPrompt, setCharacterPrompt] = useState("");
  const [characterJob, setCharacterJob] = useState<BuildJobStatus | null>(null);
  const [mapJob, setMapJob] = useState<BuildJobStatus | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const resources = buildState?.resources ?? 0;
  const costs: BuildCosts = buildState?.costs ?? { character: 20, mapExpand: 50 };

  const isCharacterJobRunning =
    characterJob?.status === "running" || characterJob?.status === "pending";
  const isMapJobRunning =
    mapJob?.status === "running" || mapJob?.status === "pending";

  const showFlash = (kind: "ok" | "err", text: string) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash(null), 3000);
  };

  const canAffordCharacter = resources >= costs.character;
  const canAffordMapExpand = resources >= costs.mapExpand;

  const formatCost = (cost: number): string => {
    return `💎 ${cost}`;
  };

  // Poll job status for character build
  useEffect(() => {
    if (!characterJob || characterJob.status === "done" || characterJob.status === "error") {
      return;
    }

    const poll = async () => {
      try {
        const status = await apiClient.getCharacterBuildJob(characterJob.jobId);
        setCharacterJob(status);
        if (status.status === "done") {
          showFlash("ok", "角色生成完成！");
          try {
            const fresh = await apiClient.getBuildState();
            onBuildStateChange?.(fresh);
          } catch { /* ignore */ }
        } else if (status.status === "error") {
          showFlash("err", "生成失败: " + (status.error || "未知错误"));
        }
      } catch (err) {
        console.warn("[BuildPanel] Failed to poll character job:", err);
      }
    };

    pollTimerRef.current = window.setInterval(poll, 2000);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [characterJob?.jobId, characterJob?.status, onBuildStateChange]);

  // Poll job status for map expand
  useEffect(() => {
    if (!mapJob || mapJob.status === "done" || mapJob.status === "error") {
      return;
    }

    const poll = async () => {
      try {
        const status = await apiClient.getMapExpandJob(mapJob.jobId);
        setMapJob(status);
        if (status.status === "done") {
          showFlash("ok", "地图扩展完成！即将刷新页面加载新地图...");
          try {
            const fresh = await apiClient.getBuildState();
            onBuildStateChange?.(fresh);
          } catch { /* ignore */ }
          // Give user time to read the flash, then reload to load new map assets
          setTimeout(() => {
            window.location.reload();
          }, 2000);
        } else if (status.status === "error") {
          showFlash("err", "扩展失败: " + (status.error || "未知错误"));
        }
      } catch (err) {
        console.warn("[BuildPanel] Failed to poll map job:", err);
      }
    };

    const timer = window.setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [mapJob?.jobId, mapJob?.status, onBuildStateChange]);

  const handleBuildCharacter = async () => {
    if (busy) return;
    const trimmed = characterPrompt.trim();
    if (!trimmed) {
      showFlash("err", "请输入角色描述");
      return;
    }
    if (!canAffordCharacter) {
      showFlash("err", "资源不足");
      return;
    }
    setBusy(true);
    try {
      const result = await apiClient.buildCharacter(trimmed);
      if (result.ok) {
        setCharacterJob({
          jobId: result.jobId,
          status: "pending",
          progress: 0,
          total: 100,
        });
        showFlash("ok", "开始生成角色...");
        setCharacterPrompt("");
      }
    } catch (err) {
      showFlash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleExpandMap = async (direction: MapDirection) => {
    if (busy) return;
    if (!canAffordMapExpand) {
      showFlash("err", "资源不足");
      return;
    }
    setBusy(true);
    try {
      const result = await apiClient.expandMap(direction);
      if (result.ok) {
        setMapJob({
          jobId: result.jobId,
          status: "pending",
          progress: 0,
          total: 100,
        });
        showFlash("ok", "开始" + DIRECTION_LABELS[direction].label + "...");
      }
    } catch (err) {
      showFlash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const characterProgress = characterJob
    ? characterJob.total > 0
      ? (characterJob.progress / characterJob.total) * 100
      : 0
    : 0;

  const mapProgress = mapJob
    ? mapJob.total > 0
      ? (mapJob.progress / mapJob.total) * 100
      : 0
    : 0;

  if (!open) return null;

  const characterBtnDisabled = busy || !canAffordCharacter || isCharacterJobRunning;
  const mapBtnDisabled = busy || !canAffordMapExpand || isMapJobRunning;

  const characterBtnText = isCharacterJobRunning
    ? "生成中..."
    : busy
    ? "提交中..."
    : "生成角色";

  return (
    <div style={panelStyle}>
      <button onClick={onClose} style={toggleBtnStyle} title="收起建造面板">
        ▸
      </button>

      <div style={panelBodyStyle(open)}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🏗️</span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>建造面板</span>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* Tabs */}
        <div style={tabsStyle}>
          {(["character", "map"] as TabKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={tabBtnStyle(tab === key)}
            >
              {key === "character" ? "生成角色" : "扩展地图"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {tab === "character" && (
            <div style={sectionStyle}>
              <label style={labelStyle}>角色描述</label>
              <textarea
                value={characterPrompt}
                onChange={(e) => setCharacterPrompt(e.target.value)}
                placeholder="描述你想要生成的角色，例如：一个年轻的铁匠，性格开朗，擅长制作武器"
                rows={3}
                style={textareaStyle}
                disabled={busy || isCharacterJobRunning}
              />
              <div style={costRowStyle}>
                <span style={{ fontSize: 11, opacity: 0.7 }}>消耗：</span>
                <span style={{ fontSize: 12 }}>
                  {formatCost(costs.character)}
                </span>
              </div>
              <button
                onClick={handleBuildCharacter}
                disabled={characterBtnDisabled}
                style={primaryBtnStyle(characterBtnDisabled)}
              >
                {characterBtnText}
              </button>

              {/* Character build progress */}
              {characterJob && characterJob.status !== "done" && characterJob.status !== "error" && (
                <div style={progressContainerStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>生成进度</span>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      {characterJob.progress}/{characterJob.total}
                    </span>
                  </div>
                  <div style={progressBarBgStyle}>
                    <div style={{ ...progressBarFillStyle, width: characterProgress + "%" }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "map" && (
            <div style={sectionStyle}>
              <label style={labelStyle}>扩展方向</label>
              <div style={directionGridStyle}>
                <div />
                <DirectionButton direction="north" onClick={() => handleExpandMap("north")} disabled={busy || isMapJobRunning} />
                <div />
                <DirectionButton direction="west" onClick={() => handleExpandMap("west")} disabled={busy || isMapJobRunning} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🗺️</div>
                <DirectionButton direction="east" onClick={() => handleExpandMap("east")} disabled={busy || isMapJobRunning} />
                <div />
                <DirectionButton direction="south" onClick={() => handleExpandMap("south")} disabled={busy || isMapJobRunning} />
                <div />
              </div>
              <div style={costRowStyle}>
                <span style={{ fontSize: 11, opacity: 0.7 }}>每次扩展消耗：</span>
                <span style={{ fontSize: 12 }}>
                  {formatCost(costs.mapExpand)}
                </span>
              </div>

              {/* Map expand progress */}
              {mapJob && mapJob.status !== "done" && mapJob.status !== "error" && (
                <div style={progressContainerStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>扩展进度</span>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      {mapJob.progress}/{mapJob.total}
                    </span>
                  </div>
                  <div style={progressBarBgStyle}>
                    <div style={{ ...progressBarFillStyle, width: mapProgress + "%" }} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Flash message */}
        {flash && (
          <div
            style={{
              ...flashStyle,
              background: flash.kind === "ok" ? "rgba(0,184,148,0.18)" : "rgba(231,76,60,0.22)",
              color: flash.kind === "ok" ? "#8df3cf" : "#ffb0b0",
              border: flash.kind === "ok"
                ? "1px solid rgba(0,184,148,0.45)"
                : "1px solid rgba(231,76,60,0.45)",
            }}
          >
            {flash.text}
          </div>
        )}
      </div>
    </div>
  );
}

function DirectionButton({
  direction,
  onClick,
  disabled,
}: {
  direction: MapDirection;
  onClick: () => void;
  disabled: boolean;
}) {
  const info = DIRECTION_LABELS[direction];
  return (
    <button onClick={onClick} disabled={disabled} style={directionBtnStyle(disabled)}>
      {info.icon}
      <div style={{ fontSize: 10, marginTop: 2 }}>{info.dirLabel}</div>
    </button>
  );
}

// --- Styles ---

const panelStyle: CSSProperties = {
  position: "fixed",
  top: "var(--top-ui-offset, 52px)",
  right: 0,
  width: 340,
  height: "calc(100vh - var(--top-ui-offset, 52px))",
  background: "linear-gradient(180deg, rgba(20,20,40,0.95), rgba(20,20,40,0.9))",
  backdropFilter: "blur(8px)",
  display: "flex",
  flexDirection: "column",
  zIndex: 90,
  pointerEvents: "auto",
  borderLeft: "1px solid rgba(255,255,255,0.08)",
  boxShadow: "-4px 0 16px rgba(0,0,0,0.3)",
};

function panelBodyStyle(open: boolean): CSSProperties {
  return {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    opacity: open ? 1 : 0,
    transition: "opacity 0.2s",
  };
}

const toggleBtnStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 16,
  width: 36,
  height: 48,
  background: "linear-gradient(90deg, rgba(26,26,46,0.95), rgba(30,30,50,0.8))",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRight: "none",
  borderRadius: "8px 0 0 8px",
  color: "#e0e0e0",
  cursor: "pointer",
  fontSize: 18,
  transform: "translateX(-100%)",
  zIndex: 91,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "-2px 0 8px rgba(0,0,0,0.3)",
  transition: "background 0.2s, color 0.2s",
};

const headerStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  color: "#e0e0e0",
  flexShrink: 0,
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#e0e0e0",
  fontSize: 22,
  cursor: "pointer",
  lineHeight: 1,
  padding: 0,
  width: 28,
  height: 28,
  opacity: 0.7,
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "10px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  flexShrink: 0,
};

const bodyStyle: CSSProperties = {
  padding: 14,
  overflowY: "auto",
  flex: 1,
  color: "#e0e0e0",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.75,
  letterSpacing: 0.2,
};

const textareaStyle: CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "#e8e8ea",
  padding: "8px 10px",
  fontSize: 13,
  resize: "vertical",
  fontFamily: "inherit",
};

const costRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "#e0e0e0",
};

const directionGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 8,
  marginBottom: 4,
};

function directionBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)",
    border: disabled
      ? "1px solid rgba(255,255,255,0.08)"
      : "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    color: disabled ? "#666" : "#e0e0e0",
    cursor: disabled ? "not-allowed" : "pointer",
    padding: "10px 8px",
    fontSize: 18,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    transition: "all 0.15s",
    opacity: disabled ? 0.5 : 1,
  };
}

function primaryBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "rgba(116,185,255,0.1)" : "rgba(0,184,148,0.22)",
    border: disabled
      ? "1px solid rgba(116,185,255,0.3)"
      : "1px solid rgba(0,184,148,0.5)",
    color: disabled ? "#888" : "#a3f7bf",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "wait" : "pointer",
    alignSelf: "flex-start",
    transition: "all 0.2s",
  };
}

const progressContainerStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  background: "rgba(255,255,255,0.04)",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.08)",
};

const progressBarBgStyle: CSSProperties = {
  height: 6,
  background: "rgba(255,255,255,0.08)",
  borderRadius: 3,
  overflow: "hidden",
};

const progressBarFillStyle: CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, #00b894, #55efc4)",
  borderRadius: 3,
  transition: "width 0.3s ease",
};

const flashStyle: CSSProperties = {
  margin: "0 14px 14px",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 12,
  flexShrink: 0,
};

function tabBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(0,184,148,0.18)" : "rgba(255,255,255,0.04)",
    border: active
      ? "1px solid rgba(0,184,148,0.45)"
      : "1px solid rgba(255,255,255,0.1)",
    color: active ? "#a3f7bf" : "#e0e0e0",
    borderRadius: 999,
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
    transition: "all 0.2s",
  };
}
