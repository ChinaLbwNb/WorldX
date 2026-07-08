import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { CSSProperties, ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WorldTimeInfo, TimelineMeta } from "../../types/api";
import { apiClient } from "../services/api-client";
import type { WorldInfo, GeneratedWorldSummary } from "../services/api-client";
import { GodPanel } from "./GodPanel";
import { SandboxChatPanel } from "./SandboxChatPanel";
import { TimelineManagerModal } from "./TimelineManagerModal";
import { OnlinePlayersPanel } from "./OnlinePlayersPanel";
import { LanguageToggle } from "../components/LanguageToggle";
import { GameIcon } from "../components/GameIcon";
import type { GameIconName } from "../components/GameIcon";
import { darkGlassPanelStyle, darkGlassSubtlePanelStyle } from "../components/panel-styles";
import { translatePeriod } from "../utils/time-i18n";
import { sortLibraryWorldsForLocale } from "../utils/library-world-sort";
import { EventBus } from "../../EventBus";
import { networkManager } from "../../systems/NetworkManager";

type ViewMode = "run" | "replay";

export function TopBar({
  multiplayerMode = false,
  worldInfo,
  gameTime,
  isDevMode,
  onToggleDevMode,
  showWalkableOverlay,
  showRegionBoundsOverlay,
  showMainAreaPointsOverlay,
  showInteractiveObjectsOverlay,
  onToggleWalkableOverlay,
  onToggleRegionBoundsOverlay,
  onToggleMainAreaPointsOverlay,
  onToggleInteractiveObjectsOverlay,
  onToggleAutoPlay,
  onNewTimeline,
  simStatus,
  autoPlayEnabled,
  isResetting,
  isReplaying,
  replayProgress,
  onHeightChange,
  resources,
  onToggleBuildPanel,
  onToggleMapPanel,
  buildPanelOpen,
  buildPanelMode,
  onToggleInventoryPanel,
  inventoryPanelOpen,
  onToggleTradePanel,
  tradePanelOpen,
  onToggleUserCharactersPanel,
  userCharactersPanelOpen,
  onToggleUserAccountPanel,
  userAccountPanelOpen,
  onToggleNpcPanel,
  npcPanelOpen,
  onToggleTimelinePanel,
  timelinePanelOpen,
  onToggleTasksPanel,
  tasksPanelOpen,
}: {
  multiplayerMode?: boolean;
  worldInfo?: WorldInfo | null;
  gameTime: WorldTimeInfo;
  isDevMode: boolean;
  onToggleDevMode: () => void;
  showWalkableOverlay: boolean;
  showRegionBoundsOverlay: boolean;
  showMainAreaPointsOverlay: boolean;
  showInteractiveObjectsOverlay: boolean;
  onToggleWalkableOverlay: () => void;
  onToggleRegionBoundsOverlay: () => void;
  onToggleMainAreaPointsOverlay: () => void;
  onToggleInteractiveObjectsOverlay: () => void;
  onToggleAutoPlay: () => void;
  onNewTimeline: () => void;
  simStatus: "idle" | "running" | "pausing" | "paused" | "error";
  autoPlayEnabled: boolean;
  isResetting: boolean;
  isReplaying: boolean;
  replayProgress: { current: number; total: number } | null;
  onHeightChange?: (height: number) => void;
  resources?: number | null;
  onToggleBuildPanel?: () => void;
  onToggleMapPanel?: () => void;
  buildPanelOpen?: boolean;
  buildPanelMode?: "character" | "map";
  onToggleInventoryPanel?: () => void;
  inventoryPanelOpen?: boolean;
  onToggleTradePanel?: () => void;
  tradePanelOpen?: boolean;
  onToggleUserCharactersPanel?: () => void;
  userCharactersPanelOpen?: boolean;
  onToggleUserAccountPanel?: () => void;
  userAccountPanelOpen?: boolean;
  onToggleNpcPanel?: () => void;
  npcPanelOpen?: boolean;
  onToggleTimelinePanel?: () => void;
  timelinePanelOpen?: boolean;
  onToggleTasksPanel?: () => void;
  tasksPanelOpen?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [availableWorlds, setAvailableWorlds] = useState<GeneratedWorldSummary[]>([]);
  const [libraryWorlds, setLibraryWorlds] = useState<GeneratedWorldSummary[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [isSwitchingWorld, setIsSwitchingWorld] = useState(false);
  const [godPanelOpen, setGodPanelOpen] = useState(false);
  const [sandboxChatOpen, setSandboxChatOpen] = useState(false);
  const [showPauseToast, setShowPauseToast] = useState(false);
  const [isChangingTickGranularity, setIsChangingTickGranularity] = useState(false);
  const [managerModalOpen, setManagerModalOpen] = useState(false);
  const [onlinePanelOpen, setOnlinePanelOpen] = useState(false);
  const [hudMenuOpen, setHudMenuOpen] = useState(false);
  const [worldTrayOpen, setWorldTrayOpen] = useState(false);
  const [timelines, setTimelines] = useState<TimelineMeta[]>([]);
  const [selectedTimelineId, setSelectedTimelineId] = useState("");
  const [isSwitchingTimeline, setIsSwitchingTimeline] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => new URLSearchParams(window.location.search).get("mode") === "replay" ? "replay" : "run",
  );
  const barRef = useRef<HTMLDivElement | null>(null);
  const isRunning = simStatus === "running";
  const isPausing = simStatus === "pausing";
  const isBusy = isRunning || isPausing || isResetting || isSwitchingWorld || isSwitchingTimeline || isChangingTickGranularity;
  const autoPlayToggleDisabled =
    isResetting || isSwitchingWorld || isSwitchingTimeline || isChangingTickGranularity || isPausing || (isRunning && !autoPlayEnabled);

  const inRunMode = viewMode === "run" && !isReplaying;
  const inReplayMode = viewMode === "replay" || isReplaying;

  const wasReplayingRef = useRef(isReplaying);
  useEffect(() => {
    if (wasReplayingRef.current && !isReplaying && viewMode === "replay") {
      setViewMode("run");
    }
    wasReplayingRef.current = isReplaying;
  }, [isReplaying, viewMode]);

  useEffect(() => {
    let cancelled = false;
    const lang = i18n.resolvedLanguage || i18n.language || "en";
    const loadWorldChoices = () => {
      const userCharacterId = multiplayerMode
        ? networkManager.getSelectedUserCharacterId() || undefined
        : undefined;
      apiClient.getGeneratedWorlds(userCharacterId)
        .then((response) => {
          if (cancelled) return;
          setAvailableWorlds(response.worlds);
          setLibraryWorlds(response.libraryWorlds ?? []);
          const sortedLib = sortLibraryWorldsForLocale(response.libraryWorlds ?? [], lang);
          const merged = [...response.worlds, ...sortedLib];
          const defaultWorldId =
            response.currentWorldId ||
            merged.find((world) => world.isCurrent)?.id ||
            merged[0]?.id ||
            "";
          if (defaultWorldId) setSelectedWorldId(defaultWorldId);
        })
        .catch(() => {});

      apiClient.getTimelines(userCharacterId)
        .then((response) => {
          if (cancelled) return;
          setTimelines(response.timelines);
          if (response.currentTimelineId) setSelectedTimelineId(response.currentTimelineId);
        })
        .catch(() => {});
    };

    loadWorldChoices();
    const onContextChanged = () => {
      loadWorldChoices();
    };
    EventBus.instance.on("local_user_character_changed", onContextChanged);
    EventBus.instance.on("local_user_character_id_changed", onContextChanged);
    EventBus.instance.on("network_connected", onContextChanged);
    return () => {
      cancelled = true;
      EventBus.instance.off("local_user_character_changed", onContextChanged);
      EventBus.instance.off("local_user_character_id_changed", onContextChanged);
      EventBus.instance.off("network_connected", onContextChanged);
    };
  }, [i18n.resolvedLanguage, i18n.language]);

  useEffect(() => {
    if (worldInfo?.currentWorldId) setSelectedWorldId(worldInfo.currentWorldId);
    if (worldInfo?.currentTimelineId) setSelectedTimelineId(worldInfo.currentTimelineId);
  }, [worldInfo?.currentWorldId, worldInfo?.currentTimelineId]);

  useEffect(() => {
    onHeightChange?.(0);
  }, [onHeightChange]);

  const handleSwitchToReplay = async () => {
    try {
      const fresh = await apiClient.getTimelines(
        multiplayerMode ? networkManager.getSelectedUserCharacterId() || undefined : undefined,
      );
      const currentTl = fresh.timelines.find((tl) => tl.id === selectedTimelineId);
      if (!currentTl || currentTl.tickCount <= 0) {
        window.alert(t("topbar.noReplayDataAlert"));
        return;
      }
    } catch {
      /* network error — let the page reload attempt replay anyway */
    }
    const params = new URLSearchParams(window.location.search);
    params.set("mode", "replay");
    window.location.search = params.toString();
  };

  const handleSwitchToRun = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("mode");
    window.location.search = params.toString();
  };

  const statusLabel =
    inReplayMode
      ? (isReplaying ? t("topbar.statusReplaying") : t("topbar.statusReplayReady"))
      : isSwitchingWorld
      ? t("topbar.statusSwitchingWorld")
      : isSwitchingTimeline
      ? t("topbar.statusSwitchingTimeline")
      : isResetting
      ? t("topbar.statusCreatingTimeline")
      : simStatus === "running"
      ? t("topbar.statusSimulating")
      : simStatus === "pausing"
      ? t("topbar.statusPausing")
      : autoPlayEnabled
        ? t("topbar.statusAutoPlay")
      : simStatus === "paused"
        ? t("topbar.statusPaused")
        : simStatus === "error"
          ? t("topbar.statusError")
          : t("topbar.statusIdle");
  const statusColor =
    inReplayMode
      ? "#e17055"
      : isSwitchingWorld || isSwitchingTimeline
      ? "#9b59b6"
      : isResetting
      ? "#e67e22"
      : simStatus === "running"
      ? "#f39c12"
      : simStatus === "pausing"
      ? "#f1c40f"
      : simStatus === "error"
        ? "#e74c3c"
        : simStatus === "paused"
          ? "#95a5a6"
          : "#00b894";

  const pauseWorldIfNeeded = () => {
    if (!autoPlayEnabled) return;
    onToggleAutoPlay();
    setShowPauseToast(true);
    setTimeout(() => setShowPauseToast(false), 3500);
  };

  const worldName = worldInfo?.worldName || "WorldX";
  const period = gameTime.period ? translatePeriod(gameTime.period) : "";
  const timeLabel = gameTime.timeString
    ? (period
      ? t("topbar.dayTimePeriod", { day: gameTime.day, time: gameTime.timeString, period })
      : t("topbar.dayTime", { day: gameTime.day, time: gameTime.timeString }))
    : t("topbar.dayOnly", { day: gameTime.day });

  const handleTimelineChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextTimelineId = event.target.value;
    if (!nextTimelineId || nextTimelineId === selectedTimelineId) return;
    const confirmed = window.confirm(t("topbar.confirmSwitchTimeline"));
    if (!confirmed) return;
    setSelectedTimelineId(nextTimelineId);
    setIsSwitchingTimeline(true);
    try {
      const selectedUserCharacterId = multiplayerMode ? networkManager.getSelectedUserCharacterId() : undefined;
      const result = await apiClient.loadTimeline(nextTimelineId, selectedUserCharacterId || undefined);
      if (result.character?.id) {
        networkManager.setSelectedUserCharacter(result.character.id, result.character.name);
      }
      const params = new URLSearchParams(window.location.search);
      if (inReplayMode) params.set("mode", "replay");
      window.location.search = params.toString();
    } catch (error) {
      console.warn("[TopBar] Failed to switch timeline:", error);
      window.alert(t("topbar.switchFailed", { error: error instanceof Error ? error.message : String(error) }));
      setIsSwitchingTimeline(false);
    }
  };

  const handleDevTickGranularityChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = Number(event.target.value);
    const currentValue = worldInfo?.sceneConfig.tickDurationMinutes ?? 15;
    if (nextValue === currentValue) return;
    const confirmed = window.confirm(
      t("topbar.confirmSwitchTickGranularity", { value: nextValue }),
    );
    if (!confirmed) { event.target.value = String(currentValue); return; }
    setIsChangingTickGranularity(true);
    try {
      await apiClient.setDevTickDurationMinutes(nextValue as 15 | 30 | 60);
      window.location.reload();
    } catch (error) {
      console.warn("[TopBar] Failed to change dev tick granularity:", error);
      window.alert(t("topbar.updateFailed", { error: error instanceof Error ? error.message : String(error) }));
      setIsChangingTickGranularity(false);
    }
  };

  const sortedLibraryWorlds = useMemo(
    () =>
      sortLibraryWorldsForLocale(
        libraryWorlds,
        i18n.resolvedLanguage || i18n.language || "en",
      ),
    [libraryWorlds, i18n.resolvedLanguage, i18n.language],
  );
  const allWorlds = [...availableWorlds, ...sortedLibraryWorlds];
  const isPublicWorld = sortedLibraryWorlds.some((world) => world.id === selectedWorldId);

  const handleWorldChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextWorldId = event.target.value;
    if (!nextWorldId || nextWorldId === selectedWorldId) return;
    const previousWorldId = selectedWorldId;
    setSelectedWorldId(nextWorldId);
    setIsSwitchingWorld(true);
    try {
      const selectedUserCharacterId = multiplayerMode ? networkManager.getSelectedUserCharacterId() : undefined;
      if (selectedUserCharacterId) {
        const entered = await apiClient.enterWorldWithUserCharacter(selectedUserCharacterId, nextWorldId);
        networkManager.setSelectedUserCharacter(entered.character.id, entered.character.name);
      } else {
        networkManager.clearSelectedUserCharacter();
        await apiClient.switchWorld(nextWorldId);
      }
      const params = new URLSearchParams(window.location.search);
      if (inReplayMode) params.set("mode", "replay");
      window.location.search = params.toString();
    } catch (error) {
      setSelectedWorldId(previousWorldId);
      console.warn("[TopBar] Failed to switch world:", error);
      window.alert(t("topbar.switchFailed", { error: error instanceof Error ? error.message : String(error) }));
      setIsSwitchingWorld(false);
    }
  };

  return (
    <div ref={barRef} style={hudRootStyle}>
      <section style={{ ...hudPanelStyle, ...topLeftPanelStyle, zIndex: worldTrayOpen ? 140 : 110 }} aria-label="world hud">
        <button
          onClick={() => setWorldTrayOpen((prev) => !prev)}
          style={worldBadgeButtonStyle}
          title="展开世界与时间线"
        >
          <GameIcon name="world" size={34} title="世界" />
          <span style={{ minWidth: 0 }}>
            <span style={worldTitleStyle}>{worldName}</span>
            <span style={worldMetaStyle}>{timeLabel}</span>
          </span>
          <span style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: statusColor,
            animation: (isBusy || isReplaying) ? "pulse 1s infinite" : "pulse 2s infinite",
            flexShrink: 0,
          }} />
        </button>

        {worldTrayOpen && (
          <div style={worldTrayStyle}>
            {allWorlds.length > 0 && (
              <label style={trayFieldStyle}>
                <span style={trayLabelStyle}>{t("topbar.worldLabel")}</span>
                <select value={selectedWorldId} onChange={handleWorldChange}
                  disabled={isBusy} style={{ ...selectStyle, width: "100%" }}>
                  {availableWorlds.length > 0 && (
                    <optgroup label={t("topbar.myWorlds")}>
                      {availableWorlds.map((world) => (
                        <option key={world.id} value={world.id}>{world.worldName}</option>
                      ))}
                    </optgroup>
                  )}
                  {sortedLibraryWorlds.length > 0 && (
                    <optgroup label={t("topbar.sampleWorlds")}>
                      {sortedLibraryWorlds.map((world) => (
                        <option key={world.id} value={world.id}>{world.worldName}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            )}
            {timelines.length > 0 && (
              <label style={trayFieldStyle}>
                <span style={trayLabelStyle}>{t("topbar.timelineLabel")}</span>
                <select value={selectedTimelineId} onChange={handleTimelineChange}
                  disabled={isBusy} style={{ ...selectStyle, width: "100%" }}>
                  {timelines.map((tl, idx) => (
                    <option key={tl.id} value={tl.id}>{formatTimelineLabel(tl, timelines.length - idx)}</option>
                  ))}
                </select>
              </label>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => setManagerModalOpen(true)} disabled={isBusy}
                style={chipBtnStyle(managerModalOpen)}
                title={t("topbar.manageTitle")}>
                {t("topbar.manage")}
              </button>
              {inRunMode && !isPublicWorld && (
                <button
                  onClick={onNewTimeline}
                  disabled={isBusy}
                  style={{
                    ...secondaryBtnStyle,
                    borderRadius: 999,
                    color: "#a3d8ff",
                    borderColor: "rgba(116,185,255,0.4)",
                    background: "rgba(116,185,255,0.12)",
                    cursor: isBusy ? "wait" : "pointer",
                    opacity: isBusy ? 0.7 : 1,
                  }}
                >
                  {isResetting ? t("topbar.creatingTimeline") : t("topbar.newTimeline")}
                </button>
              )}
              {inRunMode && (
                <button
                  onClick={() => { pauseWorldIfNeeded(); navigate("/create"); }}
                  disabled={isResetting || isSwitchingWorld}
                  style={newWorldBtnStyle(isResetting || isSwitchingWorld)}
                  title={t("topbar.newWorldTitle")}
                >
                  <GameIcon name="world" size={20} title={t("topbar.newWorld")} />
                  {t("topbar.newWorld")}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <section style={{ ...hudPanelStyle, ...topCenterPanelStyle, zIndex: 100 }} aria-label="simulation hud">
        <div style={modeToggleContainerStyle}>
          <button onClick={handleSwitchToRun} disabled={isBusy} style={modeToggleBtnStyle(inRunMode, "run")}>
            {t("topbar.run")}
          </button>
          <button
            onClick={handleSwitchToReplay}
            disabled={isBusy}
            style={modeToggleBtnStyle(inReplayMode, "replay")}
            title={t("topbar.switchToReplay")}
          >
            {t("topbar.replay")}
          </button>
        </div>
        <button
          onClick={onToggleAutoPlay}
          disabled={inRunMode ? autoPlayToggleDisabled : false}
          style={{
            ...primaryBtnStyle,
            background: autoPlayEnabled
              ? (inReplayMode ? "rgba(225,112,85,0.28)" : "rgba(116,185,255,0.24)")
              : (inReplayMode ? "rgba(225,112,85,0.14)" : "rgba(116,185,255,0.14)"),
            borderColor: inReplayMode ? "rgba(225,112,85,0.5)" : "rgba(116,185,255,0.45)",
            cursor: (inRunMode && autoPlayToggleDisabled) ? "wait" : "pointer",
            opacity: (inRunMode && autoPlayToggleDisabled) ? 0.6 : 1,
            minWidth: 72,
          }}
        >
          {autoPlayEnabled
            ? (inReplayMode ? t("topbar.pauseReplay") : t("topbar.pauseRun"))
            : (inReplayMode ? t("topbar.playReplay") : t("topbar.playRun"))}
        </button>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "rgba(238,244,255,0.76)", fontSize: 12, whiteSpace: "nowrap" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor }} />
          {statusLabel}
        </span>
        {inReplayMode && replayProgress && (
          <div style={replayProgressStyle}>
            <span>{replayProgress.current}/{replayProgress.total}</span>
            <span style={replayTrackStyle}>
              <span style={{
                ...replayFillStyle,
                width: `${replayProgress.total > 0 ? (replayProgress.current / replayProgress.total) * 100 : 0}%`,
              }} />
            </span>
          </div>
        )}
      </section>

      <section style={{ ...hudPanelStyle, ...topRightPanelStyle, zIndex: 120 }} aria-label="account hud">
        {resources !== null && resources !== undefined && (
          <ResourceDisplay resources={resources} />
        )}
        {onToggleUserAccountPanel && (
          <AccountTextButton
            label="账号"
            onClick={onToggleUserAccountPanel}
            active={userAccountPanelOpen ?? false}
            disabled={inReplayMode}
          />
        )}
        <LanguageToggle />
      </section>

      {typeof document !== "undefined" && createPortal(
        <section style={rightDockStyle} aria-label="player menu">
          {hudMenuOpen && (
            <div style={dockMenuStyle}>
              {multiplayerMode && onToggleUserCharactersPanel && (
                <HudButton icon="character" label="我的角色"
                  onClick={onToggleUserCharactersPanel}
                  disabled={inReplayMode} active={userCharactersPanelOpen ?? false} title="管理并切换我的角色" />
              )}
              {onToggleNpcPanel && (
                <HudButton icon="character" label="NPC"
                  onClick={onToggleNpcPanel} disabled={inReplayMode}
                  active={npcPanelOpen ?? false} title="查看当前世界的 NPC" />
              )}
              {onToggleInventoryPanel && (
                <HudButton icon="inventory" label="背包"
                  onClick={onToggleInventoryPanel} disabled={inReplayMode}
                  active={inventoryPanelOpen ?? false} title="查看当前角色背包" />
              )}
              {onToggleTradePanel && (
                <HudButton icon="inventory" label="交易"
                  onClick={onToggleTradePanel} disabled={inReplayMode}
                  active={tradePanelOpen ?? false} title="赠送和交换物品" />
              )}
              {multiplayerMode && (
                <HudButton icon="online" label="邀请玩家"
                  onClick={() => setOnlinePanelOpen((prev) => !prev)}
                  disabled={inReplayMode} active={onlinePanelOpen} title="查看在线玩家、邀请和踢出访客" />
              )}
              {onToggleTimelinePanel && (
                <HudButton icon="chat" label="日志"
                  onClick={onToggleTimelinePanel}
                  active={timelinePanelOpen ?? false}
                  title="查看世界事件日志" />
              )}
              {onToggleTasksPanel && (
                <HudButton icon="build" label="任务"
                  onClick={onToggleTasksPanel}
                  active={tasksPanelOpen ?? false}
                  title="查看新手引导任务" />
              )}
              <HudButton icon="chat" label="单人聊天"
                onClick={() => { setSandboxChatOpen(true); pauseWorldIfNeeded(); }}
                disabled={inReplayMode} active={sandboxChatOpen} title={t("topbar.sandboxChatTitle")} />
              {onToggleBuildPanel && resources !== null && resources !== undefined && (
                <HudButton icon="build" label="生成NPC"
                  onClick={onToggleBuildPanel} disabled={inReplayMode}
                  active={(buildPanelOpen ?? false) && buildPanelMode === "character"} title="生成 NPC" />
              )}
              {onToggleMapPanel && resources !== null && resources !== undefined && (
                <HudButton icon="world" label="地图"
                  onClick={onToggleMapPanel} disabled={inReplayMode}
                  active={(buildPanelOpen ?? false) && buildPanelMode === "map"} title="地图节点与新地图生成" />
              )}
              <HudButton icon="observer" label="上帝模式"
                onClick={() => setGodPanelOpen(true)} disabled={inReplayMode}
                active={godPanelOpen} title={t("topbar.godModeTitle")} />
              <button
                onClick={onToggleDevMode}
                style={chipBtnStyle(isDevMode)}
                title={isDevMode ? t("topbar.disableDevMode") : t("topbar.enableDevMode")}
              >
                {isDevMode ? "Dev 已开" : "工具"}
              </button>
              {isDevMode && (
                <div style={devToolGridStyle}>
                  <select
                    value={String(worldInfo?.sceneConfig.tickDurationMinutes ?? 15)}
                    onChange={handleDevTickGranularityChange}
                    disabled={isBusy || inReplayMode}
                    style={{ ...selectStyle, width: "100%" }}
                    title={t("topbar.tickTitle")}
                  >
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 h</option>
                  </select>
                  <button onClick={onToggleWalkableOverlay} style={chipBtnStyle(showWalkableOverlay)}>{t("topbar.devWalkable")}</button>
                  <button onClick={onToggleRegionBoundsOverlay} style={chipBtnStyle(showRegionBoundsOverlay)}>{t("topbar.devRegions")}</button>
                  <button onClick={onToggleMainAreaPointsOverlay} style={chipBtnStyle(showMainAreaPointsOverlay)}>{t("topbar.devPoints")}</button>
                  <button onClick={onToggleInteractiveObjectsOverlay} style={chipBtnStyle(showInteractiveObjectsOverlay)}>{t("topbar.devInteractive")}</button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setHudMenuOpen((prev) => !prev)}
            style={dockToggleStyle(hudMenuOpen)}
            title={hudMenuOpen ? "收起玩家菜单" : "展开玩家菜单"}
          >
            <GameIcon name={hudMenuOpen ? "world" : "character"} size={38} title="玩家菜单" />
            <span style={{ fontSize: 12, fontWeight: 900 }}>{hudMenuOpen ? "收起" : "菜单"}</span>
          </button>
        </section>,
        document.body,
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes resourcePop {
          0% { opacity: 0; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-4px); }
          100% { opacity: 0; transform: translateY(-16px); }
        }
        @keyframes slideDownFade {
          0% { opacity: 0; transform: translate(-50%, -10px); }
          10% { opacity: 1; transform: translate(-50%, 0); }
          90% { opacity: 1; transform: translate(-50%, 0); }
          100% { opacity: 0; transform: translate(-50%, -10px); }
        }
      `}</style>

      {showPauseToast && typeof document !== "undefined" && createPortal(
        <div style={{
          position: "fixed", top: 72, left: "50%", transform: "translateX(-50%)",
          background: "rgba(10, 14, 28, 0.95)", border: "1px solid rgba(116,185,255,0.4)",
          color: "#dff3ff", padding: "8px 16px", borderRadius: 999, fontSize: 13, fontWeight: 500,
          zIndex: 9999, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", animation: "slideDownFade 3.5s forwards",
          pointerEvents: "none", display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>⏸️</span> {t("topbar.pauseToast")}
        </div>,
        document.body
      )}

      {godPanelOpen && typeof document !== "undefined"
        ? createPortal(<GodPanel onClose={() => setGodPanelOpen(false)} />, document.body)
        : null}
      {sandboxChatOpen && typeof document !== "undefined"
        ? createPortal(<SandboxChatPanel onClose={() => setSandboxChatOpen(false)} />, document.body)
        : null}
      {managerModalOpen && typeof document !== "undefined"
        ? createPortal(<TimelineManagerModal onClose={() => setManagerModalOpen(false)} />, document.body)
        : null}
      {multiplayerMode && onlinePanelOpen && typeof document !== "undefined"
        ? createPortal(<OnlinePlayersPanel onClose={() => setOnlinePanelOpen(false)} />, document.body)
        : null}
    </div>
  );
}

// --- Resource Display Component（联机全局共享资源）---

function ResourceDisplay({ resources }: { resources: number | null | undefined }) {
  const [animating, setAnimating] = useState(false);
  const prevResourcesRef = useRef<number>(0);

  useEffect(() => {
    const prev = prevResourcesRef.current;
    if (resources !== undefined && resources !== null && resources > prev) {
      setAnimating(true);
      const timer = setTimeout(() => setAnimating(false), 600);
      return () => clearTimeout(timer);
    }
    if (resources !== undefined && resources !== null) {
      prevResourcesRef.current = resources;
    }
  }, [resources]);

  if (resources === null || resources === undefined) return null;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
      justifyContent: "center",
    }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "rgba(255, 215, 0, 0.1)",
          border: "1px solid rgba(255, 215, 0, 0.25)",
          borderRadius: 999,
          padding: "4px 12px",
          fontSize: 13,
          color: "#ffd700",
          fontWeight: 600,
          transition: "transform 0.2s, box-shadow 0.2s",
          transform: animating ? "scale(1.15)" : "scale(1)",
          boxShadow: animating ? "0 0 12px rgba(255, 215, 0, 0.5)" : "none",
          position: "relative",
        }}
        title="资源"
      >
        <GameIcon name="resource" size={24} title="资源" />
        <span style={{ minWidth: 20, textAlign: "right" }}>
          {resources}
        </span>
        {animating && (
          <span style={{
            position: "absolute",
            top: -18,
            right: 4,
            fontSize: 11,
            fontWeight: 700,
            color: "#ffd700",
            animation: "resourcePop 0.6s ease-out forwards",
          }}>
            +1
          </span>
        )}
      </div>
    </div>
  );
}

function HudButton({
  icon,
  label,
  active = false,
  disabled = false,
  title,
  onClick,
}: {
  icon: GameIconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...chipBtnStyle(active),
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px 5px 7px",
        opacity: disabled ? 0.44 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      title={title || label}
    >
      <GameIcon name={icon} size={24} title={label} />
      <span style={{ whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

function IconOnlyButton({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: GameIconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...iconOnlyBtnStyle(active),
        opacity: disabled ? 0.44 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      title={label}
    >
      <GameIcon name={icon} size={30} title={label} />
    </button>
  );
}

function AccountTextButton({
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...accountTextBtnStyle(active),
        opacity: disabled ? 0.44 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      title={label}
    >
      {label}
    </button>
  );
}

// --- Styles ---

const hudRootStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  pointerEvents: "none",
  color: "#eef4ff",
  fontFamily: "system-ui, sans-serif",
};

const hudPanelStyle: CSSProperties = {
  position: "fixed",
  pointerEvents: "auto",
  color: "#eef4ff",
  ...darkGlassSubtlePanelStyle,
};

const topLeftPanelStyle: CSSProperties = {
  top: 14,
  left: 14,
  width: "min(360px, calc(100vw - 28px))",
  borderRadius: 18,
  padding: 8,
};

const topCenterPanelStyle: CSSProperties = {
  top: 74,
  left: 14,
  transform: "none",
  display: "flex",
  alignItems: "center",
  gap: 8,
  maxWidth: "min(520px, calc(100vw - 28px))",
  minWidth: "min(320px, calc(100vw - 28px))",
  borderRadius: 999,
  padding: "7px 9px",
};

const topRightPanelStyle: CSSProperties = {
  top: 14,
  right: 14,
  display: "flex",
  alignItems: "center",
  gap: 8,
  borderRadius: 999,
  padding: "7px 9px",
};

const worldBadgeButtonStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const worldTitleStyle: CSSProperties = {
  display: "block",
  maxWidth: 250,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 16,
  fontWeight: 900,
  lineHeight: 1.1,
};

const worldMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 3,
  fontSize: 12,
  lineHeight: 1.1,
  color: "rgba(238,244,255,0.66)",
  whiteSpace: "nowrap",
};

const worldTrayStyle: CSSProperties = {
  marginTop: 10,
  display: "grid",
  gap: 8,
  padding: "10px 10px 8px",
  borderTop: "1px solid rgba(255,255,255,0.1)",
};

const trayFieldStyle: CSSProperties = {
  display: "grid",
  gap: 4,
};

const trayLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "rgba(238,244,255,0.62)",
};

const replayProgressStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "#ffd2cf",
  fontSize: 11,
  minWidth: 88,
};

const replayTrackStyle: CSSProperties = {
  position: "relative",
  display: "inline-block",
  width: 54,
  height: 4,
  overflow: "hidden",
  borderRadius: 999,
  background: "rgba(255,255,255,0.1)",
};

const replayFillStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  right: "auto",
  background: "linear-gradient(90deg, #e17055, #f39c12)",
  borderRadius: 999,
  transition: "width 0.3s ease",
};

const rightDockStyle: CSSProperties = {
  position: "fixed",
  right: 18,
  bottom: 24,
  zIndex: 2600,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 10,
  pointerEvents: "auto",
};

const dockMenuStyle: CSSProperties = {
  width: 180,
  display: "grid",
  gap: 8,
  padding: 10,
  borderRadius: 18,
  ...darkGlassPanelStyle,
};

const devToolGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 6,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.1)",
};

function dockToggleStyle(active: boolean): CSSProperties {
  return {
    width: 76,
    height: 76,
    display: "grid",
    placeItems: "center",
    alignContent: "center",
    gap: 0,
    borderRadius: 22,
    border: active ? "1px solid rgba(116,185,255,0.5)" : darkGlassSubtlePanelStyle.border,
    background: active
      ? "linear-gradient(180deg, rgba(116,185,255,0.24), rgba(104,39,230,0.18))"
      : darkGlassSubtlePanelStyle.background,
    color: "#eef4ff",
    boxShadow: active ? "0 12px 36px rgba(104,39,230,0.24)" : darkGlassSubtlePanelStyle.boxShadow,
    cursor: "pointer",
    backdropFilter: darkGlassSubtlePanelStyle.backdropFilter,
    WebkitBackdropFilter: darkGlassSubtlePanelStyle.WebkitBackdropFilter,
  };
}

function iconOnlyBtnStyle(active: boolean): CSSProperties {
  return {
    width: 46,
    height: 46,
    display: "grid",
    placeItems: "center",
    borderRadius: 16,
    border: active ? "1px solid rgba(116,185,255,0.5)" : "1px solid rgba(238,244,255,0.1)",
    background: active ? "rgba(116,185,255,0.16)" : "rgba(12,16,31,0.5)",
    boxShadow: active ? "0 8px 24px rgba(116,185,255,0.2)" : "none",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
  };
}

function accountTextBtnStyle(active: boolean): CSSProperties {
  return {
    minWidth: 54,
    height: 38,
    padding: "0 14px",
    borderRadius: 999,
    border: active ? "1px solid rgba(116,185,255,0.5)" : "1px solid rgba(238,244,255,0.1)",
    background: active ? "rgba(116,185,255,0.16)" : "rgba(12,16,31,0.5)",
    color: active ? "#dff3ff" : "#eef4ff",
    fontSize: 13,
    fontWeight: 900,
    letterSpacing: 0,
    boxShadow: active ? "0 8px 24px rgba(116,185,255,0.2)" : "none",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
  };
}

const primaryBtnStyle: CSSProperties = {
  color: "#fff",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12,
  border: "1px solid",
  transition: "all 0.2s",
};

const secondaryBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#e0e0e0",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
};

const selectStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#e0e0e0",
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 12,
};

function chipBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)",
    border: `1px solid ${active ? "rgba(116,185,255,0.42)" : "rgba(255,255,255,0.15)"}`,
    color: active ? "#dff3ff" : "#e0e0e0",
    borderRadius: 999,
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: 12,
    transition: "all 0.2s",
  };
}

function newWorldBtnStyle(disabled: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: disabled
      ? "rgba(255,255,255,0.08)"
      : "linear-gradient(120deg, rgba(116,185,255,0.32), rgba(165,91,255,0.32))",
    border: "1px solid rgba(168,193,255,0.55)",
    color: "#f6f9ff",
    borderRadius: 999,
    padding: "6px 14px",
    cursor: disabled ? "wait" : "pointer",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.02em",
    boxShadow: disabled ? "none" : "0 6px 18px rgba(116,185,255,0.18)",
    transition: "all 0.2s",
    opacity: disabled ? 0.7 : 1,
  };
}

const modeToggleContainerStyle: CSSProperties = {
  display: "inline-flex",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.15)",
  overflow: "hidden",
  background: "rgba(255,255,255,0.04)",
};

function formatTimelineLabel(tl: TimelineMeta, index: number): string {
  let timeStr = "";
  if (tl.createdAt) {
    const d = new Date(tl.createdAt);
    if (!isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      timeStr = `${mm}/${dd} ${hh}:${min}`;
    }
  }
  const tickLabel = `${tl.tickCount}t`;
  return timeStr ? `#${index} · ${timeStr} (${tickLabel})` : `#${index} (${tickLabel})`;
}

function modeToggleBtnStyle(active: boolean, mode: ViewMode): CSSProperties {
  const colors = mode === "run"
    ? { activeBg: "rgba(0,184,148,0.22)", activeBorder: "rgba(0,184,148,0.5)", activeColor: "#a3f7bf" }
    : { activeBg: "rgba(225,112,85,0.22)", activeBorder: "rgba(225,112,85,0.5)", activeColor: "#ffd2cf" };

  return {
    background: active ? colors.activeBg : "transparent",
    border: "none",
    borderRight: mode === "run" ? "1px solid rgba(255,255,255,0.1)" : "none",
    color: active ? colors.activeColor : "rgba(255,255,255,0.55)",
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    transition: "all 0.2s",
    whiteSpace: "nowrap",
  };
}
