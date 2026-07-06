import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { CharacterDetail } from "./CharacterDetail";
import { apiClient } from "../services/api-client";
import { networkManager } from "../../systems/NetworkManager";
import type { CharacterInfo, SimulationEvent } from "../../types/api";
import { formatActionName } from "../utils/event-format";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";

export function SidePanel({
  open,
  focusToken,
  selectedCharId,
  followedCharId,
  onClose,
  onSelect,
  onToggleFollow,
  events,
}: {
  open: boolean;
  focusToken?: number;
  selectedCharId: string | null;
  followedCharId: string | null;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onToggleFollow: (id: string) => void;
  events: SimulationEvent[];
}) {
  const { t } = useTranslation();
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);

  useEffect(() => {
    const loadCharacters = () =>
      apiClient.getCharacters(networkManager.getSelectedUserCharacterId() || undefined)
        .then(setCharacters)
        .catch(console.warn);
    loadCharacters();
    const timer = setInterval(() => {
      loadCharacters();
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (open) bringToFront();
  }, [bringToFront, focusToken, open]);

  if (!open) return null;

  const selectedCharacter = characters.find((character) => character.id === selectedCharId) ?? null;

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>{t("sidePanel.charList")}</div>
          <div style={subtitleStyle}>{characters.length} 个世界 NPC</div>
        </div>
        <button
          onClick={() => {
            onSelect(null);
            onClose();
          }}
          style={closeButtonStyle}
          title={t("sidePanel.collapseTitle")}
        >
          ×
        </button>
      </header>

      <div style={bodyStyle}>
        <section className="custom-scrollbar" style={listStyle}>
          {characters.map((character) => {
            const selected = character.id === selectedCharId;
            return (
              <button
                key={character.id}
                onClick={() => onSelect(character.id)}
                style={npcRowStyle(selected)}
                title={character.role}
              >
                <span style={npcNameStyle}>{character.name}</span>
                <span style={npcRoleStyle}>{character.role}</span>
                <span style={npcActionStyle}>
                  {character.currentActionLabel || formatActionName(character.currentAction || "idle")}
                </span>
              </button>
            );
          })}
          {characters.length === 0 && (
            <div style={emptyStyle}>当前地图暂无 NPC。</div>
          )}
        </section>

        <section className="custom-scrollbar" style={detailStyle}>
          {selectedCharId && selectedCharacter ? (
            <CharacterDetail
              key={selectedCharId}
              charId={selectedCharId}
              followedCharId={followedCharId}
              onToggleFollow={onToggleFollow}
              characters={characters}
              liveEvents={events}
            />
          ) : (
            <div style={emptyStyle}>选择左侧 NPC 查看详情、记忆和最近事件。</div>
          )}
        </section>
      </div>
    </aside>
  );
}

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(760, 840),
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

const bodyStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px minmax(0, 1fr)",
  gap: 12,
  padding: 12,
  height: "min(580px, calc(100vh - 130px))",
};

const listStyle: CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
  paddingRight: 4,
  borderRight: "1px solid rgba(255,255,255,0.08)",
};

const detailStyle: CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
  paddingRight: 4,
};

const npcNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#fff",
  whiteSpace: "nowrap",
};

const npcRoleStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "rgba(238,244,255,0.55)",
  fontSize: 11,
};

const npcActionStyle: CSSProperties = {
  color: "rgba(238,244,255,0.45)",
  fontSize: 11,
  whiteSpace: "nowrap",
};

const emptyStyle: CSSProperties = {
  padding: 18,
  border: "1px dashed rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "rgba(238,244,255,0.58)",
  fontSize: 12,
  lineHeight: 1.6,
};

function npcRowStyle(selected: boolean): CSSProperties {
  return {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gridTemplateRows: "auto auto",
    alignItems: "center",
    columnGap: 8,
    rowGap: 3,
    marginBottom: 6,
    padding: "9px 10px",
    borderRadius: 10,
    border: selected ? "1px solid rgba(125,212,255,0.34)" : "1px solid rgba(255,255,255,0.08)",
    background: selected ? "rgba(88,172,255,0.16)" : "rgba(255,255,255,0.045)",
    color: "#eef4ff",
    cursor: "pointer",
    textAlign: "left",
  };
}
