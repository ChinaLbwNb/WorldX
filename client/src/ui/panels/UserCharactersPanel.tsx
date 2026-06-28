import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type Phaser from "phaser";
import { EventBus } from "../../EventBus";
import { networkManager } from "../../systems/NetworkManager";
import { apiClient, type UserCharacterInfo } from "../services/api-client";

export function UserCharactersPanel({
  open,
  onClose,
  eventBus,
}: {
  open: boolean;
  onClose: () => void;
  eventBus: Phaser.Events.EventEmitter;
}) {
  const [characters, setCharacters] = useState<UserCharacterInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  const [selectedId, setSelectedId] = useState(() => networkManager.getSelectedUserCharacterId());
  const [busyId, setBusyId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [currentCharacterId, setCurrentCharacterId] = useState(() => networkManager.getSelectedUserCharacterId());

  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === selectedId) ?? null,
    [characters, selectedId],
  );

  const refresh = useCallback(async () => {
    if (!open) return;
    setError("");
    try {
      const response = await apiClient.getUserCharacters();
      setCharacters(response.characters);
      setSelectedId((current) => current || networkManager.getSelectedUserCharacterId() || response.characters[0]?.id || "");
      setCurrentCharacterId(networkManager.getSelectedUserCharacterId());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [open]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!open) return null;

  const createCharacter = async () => {
    const name = prompt.trim().slice(0, 24);
    if (!name || generating) {
      setError("请输入你想生成的角色名称或简短描述。");
      return;
    }
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const response = await apiClient.createUserCharacter(name, {
        prompt: prompt.trim(),
        generateAppearance: true,
      });
      setCharacters((prev) => [response.character, ...prev.filter((item) => item.id !== response.character.id)]);
      setSelectedId(response.character.id);
      setPrompt("");
      setNotice(`已生成角色：${response.character.name}。点击角色格子只会选中查看，点“应用”才会切换操控。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const applyCharacter = async (character: UserCharacterInfo) => {
    if (busyId) return;
    setBusyId(character.id);
    setSelectedId(character.id);
    setError("");
    setNotice("");
    try {
      const entered = await apiClient.selectUserCharacter(character.id);
      networkManager.setIdentity(entered.character.name, networkManager.getStoredCode());
      networkManager.setSelectedUserCharacter(entered.character.id, entered.character.name);
      setCurrentCharacterId(entered.character.id);
      networkManager.reconnect();
      eventBus.emit("local_user_character_changed", entered.character);
      EventBus.instance.emit("local_user_character_changed", entered.character);
      eventBus.emit("focus_user_character");
      EventBus.instance.emit("focus_user_character");
      setNotice(`已切换到：${entered.character.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  const renameCharacter = async (character: UserCharacterInfo) => {
    const nextName = window.prompt("输入新的角色名称", character.name)?.trim().slice(0, 24);
    if (!nextName || nextName === character.name) return;
    setBusyId(character.id);
    setError("");
    setNotice("");
    try {
      const response = await apiClient.updateUserCharacter(character.id, { name: nextName });
      setCharacters((prev) => prev.map((item) => item.id === character.id ? response.character : item));
      setSelectedId(character.id);
      setNotice(`已改名为：${response.character.name}`);
      if (networkManager.getSelectedUserCharacterId() === character.id) {
        networkManager.setSelectedUserCharacter(character.id, response.character.name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  const deleteCharacter = async (character: UserCharacterInfo) => {
    const isCurrent = networkManager.getSelectedUserCharacterId() === character.id;
    const confirmed = window.confirm(
      isCurrent
        ? `删除当前正在操控的角色「${character.name}」？会先退出该角色，再删除。若它有背包物品或已摆放物品，仍会被拒绝。`
        : `删除角色「${character.name}」？有背包物品或已摆放物品时会被拒绝。`,
    );
    if (!confirmed) return;
    setBusyId(character.id);
    setError("");
    setNotice("");
    try {
      if (isCurrent) {
        networkManager.clearSelectedUserCharacter();
        setCurrentCharacterId("");
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      await apiClient.deleteUserCharacter(character.id);
      setCharacters((prev) => prev.filter((item) => item.id !== character.id));
      if (selectedId === character.id) setSelectedId("");
      setNotice(`已删除角色：${character.name}`);
      if (isCurrent) {
        setTimeout(() => window.location.reload(), 100);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  return (
    <aside style={panelStyle}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>我的角色</div>
          <div style={subtitleStyle}>{characters.length} 个角色</div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭我的角色">×</button>
      </header>

      <section style={generatorStyle}>
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void createCharacter();
          }}
          placeholder="例如：黑发蓝衣的现代穿越者"
          style={inputStyle}
          maxLength={80}
        />
        <button
          onClick={() => void createCharacter()}
          disabled={generating}
          style={{
            ...generateButtonStyle,
            opacity: generating ? 0.65 : 1,
            cursor: generating ? "default" : "pointer",
          }}
          title="生成一个可操控的用户角色"
        >
          {generating ? "生成中" : "生成"}
        </button>
      </section>

      {notice && <div style={noticeStyle}>{notice}</div>}
      {error && <div style={errorStyle}>{error}</div>}

      {characters.length === 0 && !error && (
        <div style={emptyStyle}>还没有自己的角色。输入角色名称或简短描述后生成。</div>
      )}

      {characters.length > 0 && (
        <div style={bodyStyle}>
          <div style={gridStyle}>
            {characters.map((character) => {
              const selected = character.id === selectedId;
              const current = character.id === currentCharacterId;
              const busy = character.id === busyId;
              return (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => setSelectedId(character.id)}
                  style={cellStyle(selected)}
                  title={`查看 ${character.name}`}
                  disabled={Boolean(busyId)}
                >
                  <div style={avatarFrameStyle}>
                    {character.appearance?.spriteUrl ? (
                      <img
                        src={character.appearance.spriteUrl}
                        alt={character.name}
                        style={avatarImageStyle}
                      />
                    ) : (
                      <div style={avatarCircleStyle(character.appearance?.color ?? 0xffcc66)}>
                        {character.name.slice(0, 1)}
                      </div>
                    )}
                  </div>
                  <div style={cellNameStyle}>{character.name}</div>
                  {current && <div style={currentBadgeStyle}>{busy ? "切换中" : "操控中"}</div>}
                  {selected && !current && <div style={selectedBadgeStyle}>选中</div>}
                </button>
              );
            })}
          </div>

          {selectedCharacter && (
            <div style={detailStyle}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={detailNameStyle}>{selectedCharacter.name}</div>
                <div style={detailMetaStyle}>
                  {selectedCharacter.currentMapId || "map_origin"}
                {selectedCharacter.id === currentCharacterId ? " · 当前操控" : selectedCharacter.online ? " · 在线" : ""}
                </div>
              </div>
              <button
                onClick={() => void applyCharacter(selectedCharacter)}
                disabled={Boolean(busyId) || selectedCharacter.id === currentCharacterId}
                style={applyButtonStyle(Boolean(busyId) || selectedCharacter.id === currentCharacterId)}
              >
                {selectedCharacter.id === currentCharacterId ? "操控中" : busyId ? "切换中" : "应用"}
              </button>
              <button
                onClick={() => void renameCharacter(selectedCharacter)}
                disabled={Boolean(busyId)}
                style={renameButtonStyle(Boolean(busyId))}
              >
                改名
              </button>
              <button
                onClick={() => void deleteCharacter(selectedCharacter)}
                disabled={Boolean(busyId)}
                style={deleteButtonStyle(Boolean(busyId))}
              >
                删除
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

const panelStyle: CSSProperties = {
  position: "fixed",
  right: 18,
  top: "calc(var(--top-ui-offset, 52px) + 14px)",
  width: 340,
  maxWidth: "calc(100vw - 36px)",
  maxHeight: "calc(100vh - var(--top-ui-offset, 52px) - 28px)",
  zIndex: 790,
  pointerEvents: "auto",
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(17, 22, 32, 0.95)",
  boxShadow: "0 18px 45px rgba(0,0,0,0.42)",
  color: "#eef4ff",
  fontFamily: "system-ui, sans-serif",
  overflow: "hidden",
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
  fontWeight: 700,
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

const generatorStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 8,
  padding: "12px 12px 0",
};

const inputStyle: CSSProperties = {
  minWidth: 0,
  height: 34,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(0,0,0,0.22)",
  color: "#eef4ff",
  padding: "0 10px",
  outline: "none",
  fontSize: 12,
};

const generateButtonStyle: CSSProperties = {
  height: 34,
  border: "1px solid rgba(125,212,255,0.42)",
  background: "rgba(88,172,255,0.2)",
  color: "#eef8ff",
  padding: "0 12px",
  fontWeight: 700,
};

const bodyStyle: CSSProperties = {
  padding: 12,
  overflowY: "auto",
  maxHeight: "calc(100vh - var(--top-ui-offset, 52px) - 112px)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
};

function cellStyle(selected: boolean): CSSProperties {
  return {
    position: "relative",
    height: 104,
    display: "grid",
    gridTemplateRows: "66px 1fr",
    gap: 5,
    padding: 7,
    border: selected ? "1px solid rgba(125,212,255,0.9)" : "1px solid rgba(255,255,255,0.12)",
    background: selected ? "rgba(88,172,255,0.18)" : "rgba(255,255,255,0.055)",
    color: "#eef4ff",
    cursor: "pointer",
    textAlign: "center",
    boxShadow: selected ? "0 0 0 1px rgba(125,212,255,0.18) inset" : "none",
  };
}

const avatarFrameStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(0,0,0,0.18)",
  overflow: "hidden",
};

const avatarImageStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  objectPosition: "50% 78%",
  imageRendering: "auto",
};

function avatarCircleStyle(color: number): CSSProperties {
  const hex = `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, "0")}`;
  return {
    width: 42,
    height: 42,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: hex,
    color: "#111827",
    fontWeight: 900,
    fontSize: 18,
    border: "2px solid rgba(255,255,255,0.78)",
    boxShadow: "0 8px 18px rgba(0,0,0,0.24)",
  };
}

const cellNameStyle: CSSProperties = {
  minWidth: 0,
  alignSelf: "center",
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1.2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const selectedBadgeStyle: CSSProperties = {
  position: "absolute",
  right: 7,
  top: 7,
  height: 18,
  padding: "0 6px",
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.55)",
  color: "#a6e3ff",
  fontSize: 10,
  fontWeight: 800,
};

const currentBadgeStyle: CSSProperties = {
  ...selectedBadgeStyle,
  background: "rgba(85, 239, 196, 0.22)",
  color: "#9fffe7",
  border: "1px solid rgba(85, 239, 196, 0.42)",
};

const detailStyle: CSSProperties = {
  marginTop: 10,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  padding: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.2)",
};

const detailNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const detailMetaStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  color: "rgba(238,244,255,0.58)",
};

function applyButtonStyle(busy: boolean): CSSProperties {
  return {
    height: 28,
    border: "1px solid rgba(166,240,198,0.35)",
    background: busy ? "rgba(68,189,120,0.08)" : "rgba(68,189,120,0.16)",
    color: "#c9f8d9",
    padding: "0 9px",
    fontSize: 12,
    fontWeight: 700,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.65 : 1,
    flex: "0 0 auto",
  };
}

function renameButtonStyle(busy: boolean): CSSProperties {
  return {
    height: 28,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.08)",
    color: "#eef4ff",
    padding: "0 9px",
    fontSize: 12,
    fontWeight: 700,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.65 : 1,
    flex: "0 0 auto",
  };
}

function deleteButtonStyle(busy: boolean): CSSProperties {
  return {
    ...renameButtonStyle(busy),
    border: "1px solid rgba(255,128,128,0.34)",
    background: "rgba(255,105,105,0.1)",
    color: "#ffb8b8",
  };
}

const emptyStyle: CSSProperties = {
  padding: 16,
  color: "rgba(238,244,255,0.68)",
  fontSize: 13,
  lineHeight: 1.5,
};

const noticeStyle: CSSProperties = {
  margin: 12,
  marginBottom: 0,
  padding: 10,
  border: "1px solid rgba(105,255,166,0.28)",
  background: "rgba(105,255,166,0.08)",
  color: "#bdfad1",
  fontSize: 12,
};

const errorStyle: CSSProperties = {
  margin: 12,
  padding: 10,
  border: "1px solid rgba(255,105,105,0.35)",
  background: "rgba(255,105,105,0.1)",
  color: "#ffb8b8",
  fontSize: 12,
};
