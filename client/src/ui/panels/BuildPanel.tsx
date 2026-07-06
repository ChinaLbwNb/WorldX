import { useEffect, useState, useRef } from "react";
import type { CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import { networkManager } from "../../systems/NetworkManager";
import { EventBus } from "../../EventBus";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";
import type {
  BuildState,
  BuildCosts,
  BuildJobStatus,
  WorldMapNodeInfo,
} from "../../types/api";

export type BuildPanelMode = "character" | "map";

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

export function BuildPanel({
  open,
  onClose,
  buildState,
  onBuildStateChange,
  mode = "character",
}: {
  open: boolean;
  onClose: () => void;
  buildState: BuildState | null;
  onBuildStateChange?: (state: BuildState) => void;
  mode?: BuildPanelMode;
}) {
  const [characterPrompt, setCharacterPrompt] = useState("");
  const [mapPrompt, setMapPrompt] = useState("");
  const [characterJob, setCharacterJob] = useState<BuildJobStatus | null>(null);
  const [mapJob, setMapJob] = useState<BuildJobStatus | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const resources = buildState?.resources ?? 0;
  const costs: BuildCosts = buildState?.costs ?? { character: 20, mapExpand: 50, item: 8 };

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
          showFlash("ok", "NPC 生成完成！");
          EventBus.instance.emit("npc_roster_changed");
          EventBus.instance.emit("scene_sync_characters");
          try {
            const fresh = await apiClient.getBuildState(networkManager.getSelectedUserCharacterId() || undefined);
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
          showFlash("ok", "地图节点生成完成！");
          EventBus.instance.emit("map_nodes_changed");
          try {
            const fresh = await apiClient.getBuildState(networkManager.getSelectedUserCharacterId() || undefined);
            onBuildStateChange?.(fresh);
          } catch { /* ignore */ }
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
      showFlash("err", "请输入 NPC 描述");
      return;
    }
    if (!canAffordCharacter) {
      showFlash("err", `资源不足：生成 NPC 需要 ${formatCost(costs.character)}，当前只有 ${formatCost(resources)}`);
      return;
    }
    const selectedCharacterId = networkManager.getSelectedUserCharacterId();
    if (!selectedCharacterId) {
      showFlash("err", "请先选择一个账号角色进入世界");
      return;
    }
    setBusy(true);
    try {
      const result = await apiClient.buildCharacter(trimmed, selectedCharacterId);
      if (result.ok) {
        setCharacterJob({
          jobId: result.jobId,
          status: "pending",
          progress: 0,
          total: 100,
        });
        showFlash("ok", "开始生成 NPC...");
        setCharacterPrompt("");
        try {
          const fresh = await apiClient.getBuildState(networkManager.getSelectedUserCharacterId() || undefined);
          onBuildStateChange?.(fresh);
        } catch { /* ignore */ }
      }
    } catch (err) {
      showFlash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateMap = async () => {
    if (busy) return;
    const trimmed = mapPrompt.trim();
    if (!trimmed) {
      showFlash("err", "请输入新地图描述");
      return;
    }
    if (!canAffordMapExpand) {
      showFlash("err", `资源不足：生成地图需要 ${formatCost(costs.mapExpand)}，当前只有 ${formatCost(resources)}`);
      return;
    }
    const selectedCharacterId = networkManager.getSelectedUserCharacterId();
    if (!selectedCharacterId) {
      showFlash("err", "请先选择一个账号角色进入世界");
      return;
    }
    setBusy(true);
    try {
      const result = await apiClient.generateMapNode({ prompt: trimmed, userCharacterId: selectedCharacterId });
      if (result.ok) {
        setMapJob({
          jobId: result.jobId,
          status: "pending",
          progress: 0,
          total: 100,
        });
        showFlash("ok", "开始生成新地图...");
        setMapPrompt("");
        try {
          const fresh = await apiClient.getBuildState(networkManager.getSelectedUserCharacterId() || undefined);
          onBuildStateChange?.(fresh);
        } catch { /* ignore */ }
      }
    } catch (err) {
      showFlash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTravel = async (map: WorldMapNodeInfo) => {
    if (busy || map.status !== "available") return;
    const mapState = buildState?.mapNodes;
    if (mapState?.activeMapId === map.id) return;
      setBusy(true);
      try {
        const selectedCharacterId = networkManager.getSelectedUserCharacterId();
      if (!selectedCharacterId) {
        showFlash("err", "请先选择一个账号角色");
        return;
      }
      const result = await apiClient.enterMapWithUserCharacter(selectedCharacterId, map.id);
      if ("character" in result) {
        networkManager.setSelectedUserCharacter(result.character.id, result.character.name);
        networkManager.setIdentity(result.character.name);
      }
      showFlash("ok", `正在前往：${map.name}`);
      if (result.requiresReload) {
        setTimeout(() => window.location.reload(), 500);
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
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);

  useEffect(() => {
    if (open) bringToFront();
  }, [bringToFront, mode, open]);

  if (!open) return null;

  const characterBtnDisabled = busy || !canAffordCharacter || isCharacterJobRunning;
  const mapBtnDisabled = busy || !canAffordMapExpand || isMapJobRunning;

  const characterBtnText = isCharacterJobRunning
    ? "生成中..."
    : busy
    ? "提交中..."
    : canAffordCharacter
    ? "生成 NPC"
    : "资源不足";
  const mapNodesState = buildState?.mapNodes;
  const activeMapId = mapNodesState?.activeMapId;
  const mapNodes = mapNodesState?.mapNodes ?? [];
  const isCharacterMode = mode === "character";
  const panelTitle = isCharacterMode ? "生成 NPC" : "地图";
  const panelIcon = isCharacterMode ? "👤" : "🗺️";

  return (
    <div style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <div style={panelBodyStyle(open)}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>{panelIcon}</span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{panelTitle}</span>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {isCharacterMode && (
            <div style={sectionStyle}>
              <label style={labelStyle}>地图 NPC 描述</label>
              <textarea
                value={characterPrompt}
                onChange={(e) => setCharacterPrompt(e.target.value)}
                placeholder="描述想加入当前世界的 NPC，例如：一个年轻的铁匠，性格开朗，擅长制作武器"
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
                  {characterJob.message && (
                    <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>{characterJob.message}</div>
                  )}
                  {characterJob.logs && characterJob.logs.length > 0 && (
                    <LogBox logs={characterJob.logs} />
                  )}
                </div>
              )}
            </div>
          )}

          {!isCharacterMode && (
            <div style={sectionStyle}>
              <label style={labelStyle}>世界地图</label>
              {mapNodesState ? (
                <div style={worldMapListStyle}>
                  {[...mapNodes]
                    .sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX)
                    .map((map) => (
                      <button
                        key={map.id}
                        onClick={() => handleTravel(map)}
                        disabled={busy || map.status !== "available" || map.id === activeMapId}
                        style={worldMapNodeStyle(map.id === activeMapId, busy || map.status !== "available")}
                        title={map.id === activeMapId ? "当前地图" : "前往地图"}
                      >
                        <span style={{ fontSize: 17 }}>{map.id === activeMapId ? "◎" : "□"}</span>
                        <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                          <strong style={{ display: "block", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {map.name}
                          </strong>
                          <span style={{ fontSize: 10, opacity: 0.65 }}>
                            ({map.gridX}, {map.gridY}) · {map.status}
                          </span>
                        </span>
                      </button>
                    ))}
                </div>
              ) : null}

              {mapNodesState ? (
                <>
                  <label style={labelStyle}>新地图描述</label>
                  <textarea
                    value={mapPrompt}
                    onChange={(e) => setMapPrompt(e.target.value)}
                    placeholder="描述想要前往的新地图，例如：河边灯市、山中废庙、地下酒窖、城外桃花渡口"
                    rows={4}
                    style={textareaStyle}
                    disabled={busy || isMapJobRunning}
                  />
                  <button
                    onClick={handleGenerateMap}
                    disabled={mapBtnDisabled || !mapPrompt.trim()}
                    style={primaryBtnStyle(mapBtnDisabled || !mapPrompt.trim())}
                  >
                    {isMapJobRunning ? "生成中..." : canAffordMapExpand ? "生成新地图" : "资源不足"}
                  </button>
                </>
              ) : (
                <div style={emptyStateStyle}>
                  世界地图状态未加载，稍后重试。
                </div>
              )}
              <div style={costRowStyle}>
                <span style={{ fontSize: 11, opacity: 0.7 }}>生成地图消耗：</span>
                <span style={{ fontSize: 12 }}>
                  {formatCost(costs.mapExpand)}
                </span>
              </div>

              {/* Map expand progress */}
              {mapJob && mapJob.status !== "done" && mapJob.status !== "error" && (
                <div style={progressContainerStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>生成进度</span>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      {mapJob.progress}/{mapJob.total}
                    </span>
                  </div>
                  <div style={progressBarBgStyle}>
                    <div style={{ ...progressBarFillStyle, width: mapProgress + "%" }} />
                  </div>
                  {mapJob.message && (
                    <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>{mapJob.message}</div>
                  )}
                  {/* 实时日志 */}
                  {mapJob.logs && mapJob.logs.length > 0 && (
                    <LogBox logs={mapJob.logs} />
                  )}
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

function LogBox({ logs }: { logs: string[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div style={logBoxStyle}>
      {logs.map((line, i) => (
        <div key={i} style={logLineStyle}>{line}</div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// --- Styles ---

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(560, 840),
  display: "flex",
  flexDirection: "column",
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

const worldMapListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 7,
  maxHeight: 180,
  overflowY: "auto",
};

function worldMapNodeStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    background: active ? "rgba(0,184,148,0.18)" : "rgba(255,255,255,0.06)",
    border: active ? "1px solid rgba(0,184,148,0.48)" : "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: disabled && !active ? "#777" : "#e0e0e0",
    cursor: disabled || active ? "default" : "pointer",
    padding: "9px 10px",
    display: "flex",
    alignItems: "center",
    gap: 10,
    opacity: disabled && !active ? 0.55 : 1,
  };
}

const emptyStateStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "rgba(255,255,255,0.62)",
  fontSize: 12,
  lineHeight: 1.5,
  padding: "10px 12px",
  background: "rgba(255,255,255,0.05)",
};

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

const logBoxStyle: CSSProperties = {
  marginTop: 8,
  maxHeight: 200,
  overflowY: "auto",
  background: "rgba(0,0,0,0.4)",
  borderRadius: 6,
  padding: "6px 8px",
  border: "1px solid rgba(255,255,255,0.06)",
  fontFamily: "'Consolas', 'Courier New', monospace",
};

const logLineStyle: CSSProperties = {
  fontSize: 10,
  color: "rgba(255,255,255,0.55)",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};
