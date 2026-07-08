import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import { networkManager } from "../../systems/NetworkManager";
import { isMultiplayerMode } from "../../config/app-mode";
import type { SimulationEvent, CharacterInfo, LocationInfo } from "../../types/api";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";
import {
  buildCharacterNameMap,
  buildLocationNameMap,
  formatEventSummary,
  formatEventType,
} from "../utils/event-format";

export function Timeline({
  open = true,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [locations, setLocations] = useState<LocationInfo[]>([]);
  const [filterActor, setFilterActor] = useState<string>("");
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);

  const close = () => {
    if (onClose) {
      onClose();
      return;
    }
    navigate("/", { replace: true });
  };

  useEffect(() => {
    if (!open) return;
    const userCharacterId = isMultiplayerMode ? networkManager.getSelectedUserCharacterId() || undefined : undefined;
    apiClient.getEvents({ limit: 200 }).then(setEvents).catch(console.warn);
    apiClient.getCharacters(userCharacterId).then(setCharacters).catch(console.warn);
    apiClient.getLocations(userCharacterId).then(setLocations).catch(console.warn);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, navigate]);

  const characterNames = useMemo(() => buildCharacterNameMap(characters), [characters]);
  const locationNames = useMemo(() => buildLocationNameMap(locations), [locations]);

  const filtered = filterActor
    ? events.filter((e) => e.actorId === filterActor)
    : events;

  const grouped = new Map<number, SimulationEvent[]>();
  for (const e of filtered) {
    const existing = grouped.get(e.gameDay) || [];
    existing.push(e);
    grouped.set(e.gameDay, existing);
  }
  const days = Array.from(grouped.keys()).sort((a, b) => b - a);

  if (!open) return null;

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>{t("timeline.title")}</div>
          <div style={subtitleStyle}>{events.length} 条事件</div>
        </div>
        <button
          onClick={close}
          style={closeButtonStyle}
          title={t("timeline.backToWorld")}
        >
          ×
        </button>
      </header>

      <div style={filterBarStyle}>
        <select
          value={filterActor}
          onChange={(e) => setFilterActor(e.target.value)}
          style={selectStyle}
        >
          <option value="">{t("timeline.allCharacters")}</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.role})
            </option>
          ))}
        </select>
      </div>

      <div className="custom-scrollbar" style={bodyStyle}>
        <h2 style={{ display: "none" }}>
          {t("timeline.title")}
        </h2>
        {days.map((day) => (
          <div key={day} style={{ marginBottom: 24 }}>
            <h3
              style={{
                fontSize: 14,
                color: "#74b9ff",
                borderBottom: "1px solid rgba(255,255,255,0.1)",
                paddingBottom: 4,
                marginBottom: 8,
              }}
            >
              Day {day}
            </h3>
            {grouped.get(day)!.map((e, i) => (
              <div
                key={e.id || i}
                style={{
                  padding: "6px 0",
                  borderLeft: `2px solid ${
                    (e.dramScore || 0) >= 6 ? "#fdcb6e" : "rgba(255,255,255,0.1)"
                  }`,
                  paddingLeft: 12,
                  marginBottom: 4,
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: "#666" }}>{e.timeString || `T${e.gameTick}`}</span>{" "}
                <span style={{ color: typeColor(e.type) }}>[{formatEventType(e.type)}]</span>{" "}
                {(e.dramScore || 0) >= 6 && <span>★</span>}{" "}
                <span style={{ color: "#ccc" }}>
                  {formatEventSummary(e, { characterNames, locationNames })}
                </span>
              </div>
            ))}
          </div>
        ))}
        {days.length === 0 && (
          <div style={{ textAlign: "center", color: "#666", padding: 40 }}>
            {t("timeline.noEvents")}
          </div>
        )}
      </div>
    </aside>
  );
}

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(720, 840),
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

const filterBarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "10px 12px 0",
};

const selectStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#e0e0e0",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 12,
};

const bodyStyle: CSSProperties = {
  margin: 12,
  paddingRight: 6,
  maxHeight: "min(580px, calc(100vh - 160px))",
  overflowY: "auto",
  color: "#e0e0e0",
};

function typeColor(type: string): string {
  switch (type) {
    case "dialogue": return "#fdcb6e";
    case "movement": return "#74b9ff";
    case "action_start": return "#00b894";
    default: return "#888";
  }
}
