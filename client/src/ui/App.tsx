import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useState, useEffect, useCallback, useRef, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { createPortal } from "react-dom";
import Phaser from "phaser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopBar } from "./panels/TopBar";
import { SidePanel } from "./panels/SidePanel";
import { BuildPanel } from "./panels/BuildPanel";
import type { BuildPanelMode } from "./panels/BuildPanel";
import { InventoryPanel } from "./panels/InventoryPanel";
import { TradePanel } from "./panels/TradePanel";
import { UserCharactersPanel } from "./panels/UserCharactersPanel";
import { UserAccountPanel } from "./panels/UserAccountPanel";
import { MapControls } from "./panels/MapControls";
import { DialoguePanel } from "./panels/DialoguePanel";
import { SceneTransition } from "./panels/SceneTransition";
import { WorldIntroBanner } from "./panels/WorldIntroBanner";
import { JoinGate } from "./panels/JoinGate";
import { PublicChatPanel } from "./panels/PublicChatPanel";
import { TutorialTasksPanel } from "./panels/TutorialTasksPanel";
import { Timeline } from "./pages/Timeline";
import { CreateWorldPage } from "./pages/CreateWorldPage";
import { CreateWorldBackground } from "./pages/CreateWorldBackground";
import { BootScene } from "../scenes/BootScene";
import { WorldScene } from "../scenes/WorldScene";
import { networkManager } from "../systems/NetworkManager";
import type { SimulationEvent, DialogueEventData, WorldTimeInfo, BuildState } from "../types/api";
import { apiClient } from "./services/api-client";
import type { GeneratedWorldSummary, WorldInfo } from "./services/api-client";

interface WorldInvitePayload {
  id: string;
  inviterUserId: string;
  inviterName: string;
  worldId: string;
  worldName: string;
  role: string;
  expiresAt: number;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
  },
});

const DEFAULT_TOP_BAR_HEIGHT = 0;

function GameRuntime() {
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (gameRef.current) return undefined;
    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      width: window.innerWidth,
      height: window.innerHeight,
      parent: "game-root",
      transparent: true,
      render: { antialias: true, roundPixels: false },
      scale: { mode: Phaser.Scale.RESIZE },
      scene: [BootScene, WorldScene],
    });

    return () => {
      networkManager.disconnect();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return null;
}

class OverlayErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[OverlayErrorBoundary]", error, info);
    this.props.onError();
  }
  render() { return this.state.hasError ? null : this.props.children; }
}

export function App({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppContent eventBus={eventBus} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function AuthRequiredScreen({
  backgroundRoot,
}: {
  backgroundRoot: HTMLElement | null;
}) {
  return (
    <>
      {backgroundRoot &&
        createPortal(<AuthWorldCarousel />, backgroundRoot)}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 12000,
          pointerEvents: "auto",
          background:
            "linear-gradient(90deg, rgba(6,8,18,0.84) 0%, rgba(8,10,22,0.62) 44%, rgba(8,10,22,0.36) 100%)",
          color: "#eef4ff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "clamp(26px, 7vw, 96px)",
            top: "clamp(36px, 14vh, 132px)",
            maxWidth: 560,
            paddingRight: 24,
          }}
        >
          <div
            style={{
              fontSize: "clamp(58px, 10vw, 128px)",
              lineHeight: 0.9,
              fontWeight: 900,
              letterSpacing: 0,
              color: "#f6f8ff",
              textShadow: "0 20px 60px rgba(0,0,0,0.45)",
            }}
          >
            <span style={{ color: "rgb(104, 39, 230)" }}>X</span>World
          </div>
          <div
            style={{
              marginTop: 18,
              fontSize: "clamp(20px, 3vw, 34px)",
              lineHeight: 1.15,
              fontWeight: 700,
              letterSpacing: 0,
              color: "rgba(238,244,255,0.9)",
            }}
          >
            Redefine your world
          </div>
          <div
            style={{
              marginTop: 22,
              maxWidth: 430,
              fontSize: 14,
              color: "rgba(238,244,255,0.68)",
              lineHeight: 1.7,
            }}
          >
            登录后进入你的世界。角色、物品和联机身份都会绑定到你的账号。
          </div>
        </div>
        <UserAccountPanel open={true} onClose={() => undefined} />
      </div>
    </>
  );
}

function WorldInviteModal({
  invite,
  busy,
  error,
  onAccept,
  onDecline,
}: {
  invite: WorldInvitePayload;
  busy: boolean;
  error: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 13000,
        display: "grid",
        placeItems: "center",
        background: "rgba(6, 8, 18, 0.58)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          width: 360,
          maxWidth: "calc(100vw - 32px)",
          padding: 22,
          borderRadius: 14,
          background: "rgba(18, 22, 34, 0.98)",
          border: "1px solid rgba(116,185,255,0.22)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.56)",
          color: "#eef4ff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 8 }}>世界邀请</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(238,244,255,0.72)" }}>
          <b style={{ color: "#fff" }}>{invite.inviterName || "一位玩家"}</b>
          {" 邀请你进入 "}
          <b style={{ color: "#dff3ff" }}>{invite.worldName || invite.worldId}</b>
          {"。接受后你当前操控的角色会被传送到这个世界。"}
        </div>
        {error && (
          <div style={{ marginTop: 12, padding: 9, borderRadius: 8, background: "rgba(255,118,117,0.1)", border: "1px solid rgba(255,118,117,0.24)", color: "#ffb8b8", fontSize: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button
            onClick={onDecline}
            disabled={busy}
            style={{ border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.08)", color: "#eef4ff", borderRadius: 10, padding: "9px 14px", cursor: busy ? "wait" : "pointer" }}
          >
            拒绝
          </button>
          <button
            onClick={onAccept}
            disabled={busy}
            style={{ border: "1px solid rgba(116,185,255,0.5)", background: "rgba(116,185,255,0.22)", color: "#dff3ff", borderRadius: 10, padding: "9px 16px", fontWeight: 800, cursor: busy ? "wait" : "pointer" }}
          >
            {busy ? "处理中..." : "接受并进入"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthCheckingScreen({
  backgroundRoot,
}: {
  backgroundRoot: HTMLElement | null;
}) {
  return (
    <>
      {backgroundRoot &&
        createPortal(<AuthWorldCarousel />, backgroundRoot)}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 12000,
          display: "grid",
          placeItems: "center",
          pointerEvents: "auto",
          background: "rgba(8, 12, 20, 0.58)",
          color: "#eef4ff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ fontSize: 15, color: "rgba(238,244,255,0.76)" }}>
          正在验证登录...
        </div>
      </div>
    </>
  );
}

function AuthWorldCarousel() {
  const [slides, setSlides] = useState<Array<{ id: string; name: string; imageUrl: string }>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/public/world-backgrounds", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json() as Promise<{
          backgrounds?: Array<{ id: string; worldName: string; imageUrl: string }>;
        }>;
      })
      .then((response) => {
        if (cancelled) return;
        const candidates = (response.backgrounds ?? [])
          .slice(0, 8)
          .map((world) => ({
            id: world.id,
            name: world.worldName,
            imageUrl: world.imageUrl,
          }));
        setSlides(candidates);
      })
      .catch((error) => {
        console.warn("[AuthWorldCarousel] Failed to load world backgrounds:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (slides.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % slides.length);
    }, 5200);
    return () => window.clearInterval(timer);
  }, [slides.length]);

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#070819" }}>
      <CreateWorldBackground intensity="calm" />
      {slides.map((slide, index) => (
        <div
          key={slide.id}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "-4%",
            backgroundImage: `url("${slide.imageUrl}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: index === activeIndex ? 0.86 : 0,
            transform: index === activeIndex ? "scale(1.04)" : "scale(1.08)",
            transition: "opacity 1200ms ease, transform 6200ms ease",
            filter: "saturate(1.08) contrast(1.04)",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 70% 34%, rgba(104,39,230,0.20), transparent 34%), linear-gradient(180deg, rgba(3,5,12,0.16), rgba(3,5,12,0.72))",
        }}
      />
      {slides.length > 0 && (
        <div
          style={{
            position: "absolute",
            right: "clamp(22px, 4vw, 64px)",
            bottom: "clamp(22px, 5vh, 56px)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "rgba(238,244,255,0.74)",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0,
          }}
        >
          <span>{slides[activeIndex]?.name}</span>
          <span style={{ display: "flex", gap: 6 }}>
            {slides.map((slide, index) => (
              <span
                key={slide.id}
                style={{
                  width: index === activeIndex ? 18 : 6,
                  height: 6,
                  borderRadius: 999,
                  background: index === activeIndex ? "rgb(104, 39, 230)" : "rgba(238,244,255,0.38)",
                  transition: "width 220ms ease, background 220ms ease",
                }}
              />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

function AppContent({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const backgroundRoot =
    typeof document === "undefined" ? null : document.getElementById("background-root");
  const isDevMode = new URLSearchParams(location.search).get("dev") === "1";
  const isCreateRoute = location.pathname === "/create";
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "anonymous">(
    () => networkManager.getAuthToken() ? "checking" : "anonymous",
  );
  const isAuthenticated = authStatus === "authenticated";
  const [worldsList, setWorldsList] = useState<GeneratedWorldSummary[] | null>(null);
  const [hasUserWorlds, setHasUserWorlds] = useState(false);
  const [gameTime, setGameTime] = useState<WorldTimeInfo>({
    day: 1,
    tick: 0,
    timeString: "08:00",
    period: "上午",
  });
  const [worldInfo, setWorldInfo] = useState<WorldInfo | null>(null);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [followedCharId, setFollowedCharId] = useState<string | null>(null);
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [simStatus, setSimStatus] = useState<"idle" | "running" | "pausing" | "paused" | "error">("idle");
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState<{ current: number; total: number } | null>(null);
  const [dialogueEvents, setDialogueEvents] = useState<SimulationEvent[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const lastTimelineKeyRef = useRef<string | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<"hidden" | "ending" | "starting" | "fade-out">("hidden");
  const [lastKnownDay, setLastKnownDay] = useState(0);
  const [topBarHeight, setTopBarHeight] = useState(DEFAULT_TOP_BAR_HEIGHT);
  const [showWalkableOverlay, setShowWalkableOverlay] = useState(false);
  const [showRegionBoundsOverlay, setShowRegionBoundsOverlay] = useState(false);
  const [showMainAreaPointsOverlay, setShowMainAreaPointsOverlay] = useState(false);
  const [showInteractiveObjectsOverlay, setShowInteractiveObjectsOverlay] = useState(false);
  const [buildState, setBuildState] = useState<BuildState | null>(null);
  const [buildPanelOpen, setBuildPanelOpen] = useState(false);
  const [buildPanelMode, setBuildPanelMode] = useState<BuildPanelMode>("character");
  const [inventoryPanelOpen, setInventoryPanelOpen] = useState(false);
  const [tradePanelOpen, setTradePanelOpen] = useState(false);
  const [userCharactersPanelOpen, setUserCharactersPanelOpen] = useState(false);
  const [userAccountPanelOpen, setUserAccountPanelOpen] = useState(false);
  const [npcPanelOpen, setNpcPanelOpen] = useState(false);
  const [npcPanelFocusToken, setNpcPanelFocusToken] = useState(0);
  const [timelinePanelOpen, setTimelinePanelOpen] = useState(false);
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const [worldInvite, setWorldInvite] = useState<WorldInvitePayload | null>(null);
  const [worldInviteBusy, setWorldInviteBusy] = useState(false);
  const [worldInviteError, setWorldInviteError] = useState("");
  const isOverlayRoute = false;
  const hideMainChrome = isCreateRoute;
  const ticksPerScene = worldInfo?.sceneRuntime.cycleTicks ?? 48;
  const showDayTransition = worldInfo?.sceneRuntime.transitionEnabled ?? false;
  const endTransitionTitle =
    worldInfo?.sceneConfig.multiDay.endOfDayText || t("app.defaultEndTransition");
  const startTransitionTitle =
    worldInfo?.sceneConfig.multiDay.newDayText ||
    (worldInfo?.sceneConfig.sceneType === "open" ? t("app.defaultStartTransitionOpen") : t("app.defaultStartTransitionClosed"));

  useEffect(() => {
    if (!networkManager.getAuthToken()) {
      setAuthStatus("anonymous");
      return;
    }
    let cancelled = false;
    setAuthStatus("checking");
    apiClient.getAuthMe()
      .then((response) => {
        if (cancelled) return;
        networkManager.setUserId(response.user.id);
        setAuthStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        networkManager.clearAuthSession();
        setAuthStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    eventBus.emit("set_cycle_ticks", ticksPerScene);
  }, [ticksPerScene, eventBus]);

  useEffect(() => {
    const onInvite = (payload: WorldInvitePayload) => {
      setWorldInvite(payload);
      setWorldInviteError("");
      setWorldInviteBusy(false);
    };
    const onInviteAccepted = () => {
      eventBus.emit("world_members_changed");
    };
    const onInviteDeclined = () => {
      eventBus.emit("world_members_changed");
    };
    eventBus.on("world_invite_received", onInvite);
    eventBus.on("world_invite_accepted", onInviteAccepted);
    eventBus.on("world_invite_declined", onInviteDeclined);
    return () => {
      eventBus.off("world_invite_received", onInvite);
      eventBus.off("world_invite_accepted", onInviteAccepted);
      eventBus.off("world_invite_declined", onInviteDeclined);
    };
  }, [eventBus]);

  useEffect(() => {
    const timelineId = worldInfo?.currentTimelineId;
    if (!timelineId) return;

    const timelineKey = `${worldInfo?.currentWorldId ?? ""}:${timelineId}`;
    if (lastTimelineKeyRef.current === null) {
      lastTimelineKeyRef.current = timelineKey;
      return;
    }
    if (lastTimelineKeyRef.current === timelineKey) return;

    lastTimelineKeyRef.current = timelineKey;
    setEvents([]);
    setDialogueEvents([]);
    setDismissedIds(new Set());
    setReplayProgress(null);
  }, [worldInfo?.currentWorldId, worldInfo?.currentTimelineId]);

  useEffect(() => {
    const topOffset = hideMainChrome ? 0 : Math.max(topBarHeight, DEFAULT_TOP_BAR_HEIGHT);
    document.documentElement.style.setProperty("--top-ui-offset", `${topOffset}px`);

    const rafId = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [hideMainChrome, topBarHeight]);

  // Hide Phaser roots on routes that fully take over the screen. Auth pages do
  // not mount GameRuntime, but this also clears any old canvas during logout.
  useEffect(() => {
    const gameRoot = document.getElementById("game-root");
    const labelRoot = document.getElementById("label-root");
    const hidden = !isAuthenticated || isCreateRoute;
    // Keep layout dimensions intact while hiding the roots. Phaser's RESIZE mode
    // can emit framebuffer errors if we force a resize while the parent is display:none.
    if (gameRoot) {
      gameRoot.style.visibility = hidden ? "hidden" : "";
      gameRoot.style.opacity = hidden ? "0" : "";
    }
    if (labelRoot) {
      labelRoot.style.visibility = hidden ? "hidden" : "";
      labelRoot.style.opacity = hidden ? "0" : "";
    }
    return () => {
      if (gameRoot) {
        gameRoot.style.visibility = "";
        gameRoot.style.opacity = "";
      }
      if (labelRoot) {
        labelRoot.style.visibility = "";
        labelRoot.style.opacity = "";
      }
    };
  }, [isAuthenticated, isCreateRoute]);

  // Load the list of generated worlds once so we can auto-redirect to /create
  // when the install is empty.
  useEffect(() => {
    if (!isAuthenticated) {
      setWorldsList(null);
      setHasUserWorlds(false);
      return;
    }
    let cancelled = false;
    setWorldsList(null);
    apiClient.getGeneratedWorlds(networkManager.getSelectedUserCharacterId() || undefined)
      .then((response) => {
        if (cancelled) return;
        const all = [...response.worlds, ...(response.libraryWorlds ?? [])];
        setWorldsList(all);
        setHasUserWorlds(response.worlds.length > 0);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[App] Failed to load generated worlds list:", error);
        setWorldsList([]);
        setHasUserWorlds(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (worldsList === null) return;
    if (worldsList.length === 0 && !isCreateRoute) {
      navigate("/create", { replace: true });
    }
  }, [isAuthenticated, worldsList, isCreateRoute, navigate]);

  useEffect(() => {
    if (isDevMode) return;
    setShowWalkableOverlay(false);
    setShowRegionBoundsOverlay(false);
    setShowMainAreaPointsOverlay(false);
    setShowInteractiveObjectsOverlay(false);
  }, [isDevMode]);

  useEffect(() => {
    eventBus.emit("toggle_debug_walkable_overlay", isDevMode && showWalkableOverlay);
  }, [eventBus, isDevMode, showWalkableOverlay]);

  useEffect(() => {
    eventBus.emit("toggle_debug_region_bounds_overlay", isDevMode && showRegionBoundsOverlay);
  }, [eventBus, isDevMode, showRegionBoundsOverlay]);

  useEffect(() => {
    eventBus.emit("toggle_debug_main_area_points_overlay", isDevMode && showMainAreaPointsOverlay);
  }, [eventBus, isDevMode, showMainAreaPointsOverlay]);

  useEffect(() => {
    eventBus.emit("toggle_debug_interactive_objects_overlay", isDevMode && showInteractiveObjectsOverlay);
  }, [eventBus, isDevMode, showInteractiveObjectsOverlay]);

  useEffect(() => {
    if (lastKnownDay === 0) {
      if (gameTime.day > 0) setLastKnownDay(gameTime.day);
      return;
    }

    if (!showDayTransition) {
      if (transitionPhase !== "hidden") setTransitionPhase("hidden");
      if (lastKnownDay !== gameTime.day) {
        setLastKnownDay(gameTime.day);
        eventBus.emit("scene_sync_characters");
      }
      return;
    }

    if (gameTime.day > lastKnownDay) {
      setLastKnownDay(gameTime.day);
      setTransitionPhase("starting");
      eventBus.emit("scene_sync_characters");
      
      setTimeout(() => {
        setTransitionPhase("fade-out");
        setTimeout(() => setTransitionPhase("hidden"), 1500);
      }, 3000);
    } else if (gameTime.day < lastKnownDay) {
      setLastKnownDay(gameTime.day);
    }
  }, [gameTime.day, lastKnownDay, showDayTransition, transitionPhase, eventBus]);

  useEffect(() => {
    const onSceneEnding = () => {
      setTransitionPhase("ending");
    };
    eventBus.on("scene_ending", onSceneEnding);
    return () => {
      eventBus.off("scene_ending", onSceneEnding);
    };
  }, [eventBus]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const refreshWorldContext = async () => {
      try {
        const userCharacterId = networkManager.getSelectedUserCharacterId() || undefined;
        const [info, time, build] = await Promise.all([
          apiClient.getWorldInfo(userCharacterId),
          apiClient.getWorldTime(userCharacterId),
          apiClient.getBuildState(userCharacterId).catch(() => null),
        ]);
        if (cancelled) return;
        setWorldInfo(info);
        setGameTime(time);
        if (build) setBuildState(build);
      } catch (error) {
        if (!cancelled) {
          console.warn("[App] Failed to load world context:", error);
        }
      }
    };

    const onContextChanged = () => {
      void refreshWorldContext();
    };

    void refreshWorldContext();
    eventBus.on("local_user_character_changed", onContextChanged);
    eventBus.on("network_connected", onContextChanged);
    eventBus.on("map_nodes_changed", onContextChanged);

    return () => {
      cancelled = true;
      eventBus.off("local_user_character_changed", onContextChanged);
      eventBus.off("network_connected", onContextChanged);
      eventBus.off("map_nodes_changed", onContextChanged);
    };
  }, [eventBus, isAuthenticated]);

  // Auto-enter replay mode when ?mode=replay is in the URL
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("mode") !== "replay") return;
    const timelineId = worldInfo?.currentTimelineId;
    if (!timelineId) return;
    const timer = setTimeout(() => {
      eventBus.emit("start_replay", timelineId);
    }, 600);
    return () => clearTimeout(timer);
  }, [worldInfo?.currentTimelineId, location.search, eventBus]);

  useEffect(() => {
    const onTimeUpdate = (time: WorldTimeInfo) => setGameTime(time);
    const onCharClick = (id: string) => {
      setSelectedCharId(id);
      setNpcPanelOpen(true);
      setNpcPanelFocusToken((value) => value + 1);
    };
    const onSimEvent = (event: SimulationEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 50));
    };
    const onSimStatus = (payload: { status?: "idle" | "running" | "pausing" | "paused" | "error" }) => {
      if (payload.status) setSimStatus(payload.status);
    };
    const onDialogue = (event: SimulationEvent) => {
      const dialogue = event.data as DialogueEventData | undefined;
      if (dialogue?.conversationId) {
        setDismissedIds((prev) => {
          if (!prev.has(dialogue.conversationId)) return prev;
          const next = new Set(prev);
          next.delete(dialogue.conversationId);
          return next;
        });
      }
      setDialogueEvents((prev) => [...prev, event]);
    };
    const onPlaybackState = (payload: { autoPlay?: boolean }) => {
      if (payload.autoPlay != null) setAutoPlayEnabled(payload.autoPlay);
    };
    const onReplayMode = (payload: { active: boolean }) => {
      setIsReplaying(payload.active);
      if (payload.active) {
        setEvents([]);
        setDialogueEvents([]);
        setDismissedIds(new Set());
      }
      if (!payload.active) setReplayProgress(null);
    };
    const onReplayProgress = (payload: { current: number; total: number }) => {
      setReplayProgress(payload);
    };
    const onReplayFinished = () => {
      setIsReplaying(false);
    };
    const onBuildStateUpdated = (state: BuildState) => {
      setBuildState(state);
    };
    const onResourceCollected = (payload: { resources: number; gained: number; objectId: string }) => {
      setBuildState((prev) =>
        prev ? { ...prev, resources: payload.resources } : prev
      );
      void apiClient.reportTutorialTaskEvent("collect_resource").catch(() => undefined);
    };
    const onItemGenerated = (payload: { resources: number }) => {
      setBuildState((prev) =>
        prev ? { ...prev, resources: payload.resources } : prev
      );
      void apiClient.reportTutorialTaskEvent("generate_item").catch(() => undefined);
    };
    const onMapItemPlaced = () => {
      void apiClient.reportTutorialTaskEvent("place_item").catch(() => undefined);
    };
    const onMapNodesChanged = () => {
      void apiClient.reportTutorialTaskEvent("generate_map_node").catch(() => undefined);
    };

    eventBus.on("time_update", onTimeUpdate);
    eventBus.on("character_clicked", onCharClick);
    eventBus.on("sim_event", onSimEvent);
    eventBus.on("simulation_status", onSimStatus);
    eventBus.on("dialogue", onDialogue);
    eventBus.on("playback_state", onPlaybackState);
    eventBus.on("set_replay_mode", onReplayMode);
    eventBus.on("replay_progress", onReplayProgress);
    eventBus.on("replay_finished", onReplayFinished);
    eventBus.on("build_state_updated", onBuildStateUpdated);
    eventBus.on("resource_collected", onResourceCollected);
    eventBus.on("item_generated", onItemGenerated);
    eventBus.on("item_placed", onMapItemPlaced);
    eventBus.on("map_item_placed", onMapItemPlaced);
    eventBus.on("map_nodes_changed", onMapNodesChanged);

    return () => {
      eventBus.off("time_update", onTimeUpdate);
      eventBus.off("character_clicked", onCharClick);
      eventBus.off("sim_event", onSimEvent);
      eventBus.off("simulation_status", onSimStatus);
      eventBus.off("dialogue", onDialogue);
      eventBus.off("playback_state", onPlaybackState);
      eventBus.off("set_replay_mode", onReplayMode);
      eventBus.off("replay_progress", onReplayProgress);
      eventBus.off("replay_finished", onReplayFinished);
      eventBus.off("build_state_updated", onBuildStateUpdated);
      eventBus.off("resource_collected", onResourceCollected);
      eventBus.off("item_generated", onItemGenerated);
      eventBus.off("item_placed", onMapItemPlaced);
      eventBus.off("map_item_placed", onMapItemPlaced);
      eventBus.off("map_nodes_changed", onMapNodesChanged);
    };
  }, [eventBus]);


  const handleToggleDevMode = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (isDevMode) {
      params.delete("dev");
    } else {
      params.set("dev", "1");
    }
    const newSearch = params.toString();
    navigate(`${location.pathname}${newSearch ? `?${newSearch}` : ""}`, { replace: true });
  }, [isDevMode, location.pathname, location.search, navigate]);

  const handleToggleAutoPlay = useCallback(() => {
    eventBus.emit("set_auto_play", !autoPlayEnabled);
  }, [autoPlayEnabled, eventBus]);

  const handleNewTimeline = useCallback(async () => {
    if (!isAuthenticated) return;
    const confirmed = window.confirm(t("app.confirmNewTimeline"));
    if (!confirmed) return;

    setIsResetting(true);
    try {
      await apiClient.createNewTimeline(networkManager.getSelectedUserCharacterId() || undefined);
      window.location.reload();
    } catch (error) {
      console.warn("[App] Failed to create new timeline:", error);
      window.alert(t("app.failedPrefix", { error: error instanceof Error ? error.message : String(error) }));
      setIsResetting(false);
    }
  }, [isAuthenticated, t]);

  const handleToggleFollowChar = useCallback(
    (id: string) => {
      if (followedCharId === id) {
        eventBus.emit("unfollow_character");
        setFollowedCharId(null);
        return;
      }

      eventBus.emit("follow_character", id);
      setFollowedCharId(id);
    },
    [eventBus, followedCharId]
  );

  const handleOverlayError = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const respondToWorldInvite = useCallback(async (accepted: boolean) => {
    if (!worldInvite || worldInviteBusy) return;
    const userCharacterId = networkManager.getSelectedUserCharacterId();
    if (accepted && !userCharacterId) {
      setWorldInviteError("请先选择一个账号角色，再接受世界邀请。");
      return;
    }
    setWorldInviteBusy(true);
    setWorldInviteError("");
    try {
      const response = await apiClient.respondWorldInvite({
        inviteId: worldInvite.id,
        accepted,
        userCharacterId: accepted ? userCharacterId : undefined,
      });
      if (!accepted || !response.accepted) {
        setWorldInvite(null);
        return;
      }
      if (!response.worldId) {
        throw new Error("邀请响应缺少目标世界");
      }
      const entered = await apiClient.enterWorldWithUserCharacter(userCharacterId, response.worldId);
      networkManager.setIdentity(entered.character.name);
      networkManager.setSelectedUserCharacter(entered.character.id, entered.character.name);
      eventBus.emit("local_user_character_changed", entered.character);
      networkManager.reconnect();
      setWorldInvite(null);
      if (entered.requiresReload) {
        setTimeout(() => window.location.reload(), 100);
      }
    } catch (error) {
      setWorldInviteError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorldInviteBusy(false);
    }
  }, [eventBus, worldInvite, worldInviteBusy]);

  const handleOpenBuildPanel = useCallback((mode: BuildPanelMode) => {
    setBuildPanelMode(mode);
    setBuildPanelOpen((prev) => (prev && buildPanelMode === mode ? false : true));
  }, [buildPanelMode]);

  const handleToggleInventoryPanel = useCallback(() => {
    setInventoryPanelOpen((prev) => !prev);
  }, []);
  const handleToggleTradePanel = useCallback(() => {
    setTradePanelOpen((prev) => !prev);
  }, []);
  const handleToggleUserCharactersPanel = useCallback(() => {
    setUserCharactersPanelOpen((prev) => !prev);
  }, []);
  const handleToggleUserAccountPanel = useCallback(() => {
    setUserAccountPanelOpen((prev) => !prev);
  }, []);

  const handleBuildStateChange = useCallback((state: BuildState) => {
    setBuildState(state);
  }, []);

  // Periodically refresh build state (every 2 seconds)
  useEffect(() => {
    if (!isAuthenticated) return;
    if (isCreateRoute || isOverlayRoute) return;

    let cancelled = false;

    const refresh = async () => {
      try {
        const userCharacterId = networkManager.getSelectedUserCharacterId() || undefined;
        const state = await apiClient.getBuildState(userCharacterId);
        if (!cancelled) {
          setBuildState(state);
        }
      } catch {
        // Build system may not be available — that's fine.
      }
    };

    // Initial load
    void refresh();

    const timer = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAuthenticated, isCreateRoute, isOverlayRoute]);

  const overlayContent =
    location.pathname === "/timeline" ? (
      <Timeline onClose={() => navigate("/", { replace: true })} />
    ) : null;

  const overlay = overlayContent ? (
    <OverlayErrorBoundary key={location.pathname} onError={handleOverlayError}>
      {overlayContent}
    </OverlayErrorBoundary>
  ) : null;

  if (authStatus === "checking") {
    return <AuthCheckingScreen backgroundRoot={backgroundRoot} />;
  }

  if (isCreateRoute) {
    if (!isAuthenticated) {
      return <AuthRequiredScreen backgroundRoot={backgroundRoot} />;
    }
    return (
      <div style={{ width: "100%", height: "100%", pointerEvents: "auto" }}>
        {backgroundRoot &&
          createPortal(<CreateWorldBackground intensity="calm" />, backgroundRoot)}
        <CreateWorldPage hasExistingWorlds={hasUserWorlds} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthRequiredScreen backgroundRoot={backgroundRoot} />;
  }

  return (
    <>
      <GameRuntime />
      {backgroundRoot &&
        createPortal(<CreateWorldBackground intensity="calm" />, backgroundRoot)}
      {!isOverlayRoute && <JoinGate eventBus={eventBus} />}
      {worldInvite && (
        <WorldInviteModal
          invite={worldInvite}
          busy={worldInviteBusy}
          error={worldInviteError}
          onAccept={() => void respondToWorldInvite(true)}
          onDecline={() => void respondToWorldInvite(false)}
        />
      )}
      {!hideMainChrome && <PublicChatPanel eventBus={eventBus} />}
      <div style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
        {!hideMainChrome && (
        <>
          <TopBar
            worldInfo={worldInfo}
            gameTime={gameTime}
            isDevMode={isDevMode}
            onToggleDevMode={handleToggleDevMode}
            showWalkableOverlay={showWalkableOverlay}
            showRegionBoundsOverlay={showRegionBoundsOverlay}
            showMainAreaPointsOverlay={showMainAreaPointsOverlay}
            showInteractiveObjectsOverlay={showInteractiveObjectsOverlay}
            onToggleWalkableOverlay={() => setShowWalkableOverlay((prev) => !prev)}
            onToggleRegionBoundsOverlay={() => setShowRegionBoundsOverlay((prev) => !prev)}
            onToggleMainAreaPointsOverlay={() => setShowMainAreaPointsOverlay((prev) => !prev)}
            onToggleInteractiveObjectsOverlay={() => setShowInteractiveObjectsOverlay((prev) => !prev)}
            onToggleAutoPlay={handleToggleAutoPlay}
            onNewTimeline={handleNewTimeline}
            simStatus={simStatus}
            autoPlayEnabled={autoPlayEnabled}
            isResetting={isResetting}
            isReplaying={isReplaying}
            replayProgress={replayProgress}
            onHeightChange={setTopBarHeight}
            resources={buildState?.resources ?? null}
            onToggleBuildPanel={() => handleOpenBuildPanel("character")}
            onToggleMapPanel={() => handleOpenBuildPanel("map")}
            buildPanelOpen={buildPanelOpen}
            buildPanelMode={buildPanelMode}
            onToggleInventoryPanel={handleToggleInventoryPanel}
            inventoryPanelOpen={inventoryPanelOpen}
            onToggleTradePanel={handleToggleTradePanel}
            tradePanelOpen={tradePanelOpen}
            onToggleUserCharactersPanel={handleToggleUserCharactersPanel}
            userCharactersPanelOpen={userCharactersPanelOpen}
            onToggleUserAccountPanel={handleToggleUserAccountPanel}
            userAccountPanelOpen={userAccountPanelOpen}
            onToggleNpcPanel={() => {
              setNpcPanelOpen(true);
              setNpcPanelFocusToken((value) => value + 1);
            }}
            npcPanelOpen={npcPanelOpen}
            onToggleTimelinePanel={() => setTimelinePanelOpen((prev) => !prev)}
            timelinePanelOpen={timelinePanelOpen}
            onToggleTasksPanel={() => setTasksPanelOpen((prev) => !prev)}
            tasksPanelOpen={tasksPanelOpen}
          />
          {worldInfo && (worldInfo.originalPrompt?.trim() || worldInfo.worldDescription?.trim()) && (
            <WorldIntroBanner
              worldKey={worldInfo.currentWorldId || worldInfo.worldName}
              worldName={worldInfo.worldName}
              worldDescription={worldInfo.originalPrompt?.trim() || worldInfo.worldDescription}
              hasRun={(worldInfo.timelineTickCount ?? 0) > 0}
              topOffset={Math.max(topBarHeight, DEFAULT_TOP_BAR_HEIGHT)}
            />
          )}
          <SidePanel
            open={npcPanelOpen}
            focusToken={npcPanelFocusToken}
            selectedCharId={selectedCharId}
            followedCharId={followedCharId}
            onClose={() => setNpcPanelOpen(false)}
            onSelect={setSelectedCharId}
            onToggleFollow={handleToggleFollowChar}
            events={events}
          />
          <BuildPanel
            open={buildPanelOpen}
            onClose={() => setBuildPanelOpen(false)}
            buildState={buildState}
            onBuildStateChange={handleBuildStateChange}
            mode={buildPanelMode}
          />
          <InventoryPanel
            open={inventoryPanelOpen}
            onClose={handleToggleInventoryPanel}
            eventBus={eventBus}
          />
          <TradePanel
            open={tradePanelOpen}
            onClose={handleToggleTradePanel}
            eventBus={eventBus}
          />
          <UserCharactersPanel
            open={userCharactersPanelOpen}
            onClose={handleToggleUserCharactersPanel}
            eventBus={eventBus}
          />
          <UserAccountPanel
            open={userAccountPanelOpen}
            onClose={handleToggleUserAccountPanel}
          />
          <Timeline
            open={timelinePanelOpen}
            onClose={() => setTimelinePanelOpen(false)}
          />
          <TutorialTasksPanel
            open={tasksPanelOpen}
            alwaysVisible
            onClose={() => setTasksPanelOpen(false)}
            onExpand={() => setTasksPanelOpen(true)}
          />
          <DialoguePanel
            events={dialogueEvents.filter(
              (e) => {
                const d = e.data as DialogueEventData | undefined;
                return d?.conversationId && !dismissedIds.has(d.conversationId);
              }
            )}
            ticksPerScene={ticksPerScene}
            onDismiss={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
          />
          <MapControls eventBus={eventBus} />
          <SceneTransition
            day={gameTime.day + (transitionPhase === "ending" ? 1 : 0)}
            phase={transitionPhase}
            title={transitionPhase === "ending" ? endTransitionTitle : startTransitionTitle}
            timeString={transitionPhase === "ending" ? "" : (gameTime.timeString || worldInfo?.sceneConfig.multiDay.nextDayStartTime)}
            periodLabel={transitionPhase === "ending" ? "" : gameTime.period}
            variant={worldInfo?.sceneConfig.sceneType === "open" ? "open" : "closed"}
            onCovered={() => eventBus.emit("scene_covered")}
          />
        </>
        )}
        {overlay}
      </div>
    </>
  );
}
