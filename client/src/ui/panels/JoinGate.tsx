import { useEffect, useState, useCallback } from "react";
import type { CSSProperties } from "react";
import type Phaser from "phaser";
import { networkManager } from "../../systems/NetworkManager";
import { apiClient, type GeneratedWorldSummary, type UserCharacterInfo } from "../services/api-client";

/**
 * 联机进入弹窗：收集昵称 + 房间邀请码。
 * - 首次访问（未设置昵称）时显示，让玩家取名。
 * - 服务端因邀请码错误拒绝（join_rejected）时显示并提示。
 * - 连接成功（network_connected）后自动隐藏。
 */
export function JoinGate({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
  const [visible, setVisible] = useState<boolean>(
    () => !networkManager.getSelectedUserCharacterId(),
  );
  const [code, setCode] = useState<string>(() => networkManager.getStoredCode());
  const [characters, setCharacters] = useState<UserCharacterInfo[]>([]);
  const [worlds, setWorlds] = useState<GeneratedWorldSummary[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>(() => networkManager.getSelectedUserCharacterId());
  const [selectedWorldId, setSelectedWorldId] = useState<string>(() => new URLSearchParams(window.location.search).get("joinWorld") ?? "");
  const [error, setError] = useState<string>("");
  const [connecting, setConnecting] = useState<boolean>(false);

  const refreshChoices = useCallback(async () => {
    try {
      const [userChars, worldList] = await Promise.all([
        apiClient.getUserCharacters(),
        apiClient.getGeneratedWorlds(),
      ]);
      const allWorlds = [...worldList.worlds, ...worldList.libraryWorlds];
      setCharacters(userChars.characters);
      setWorlds(allWorlds);
      setSelectedCharacterId((current) => current || networkManager.getSelectedUserCharacterId() || userChars.characters[0]?.id || "");
      setSelectedWorldId((current) => {
        if (current && allWorlds.some((world) => world.id === current)) return current;
        const requestedWorldId = new URLSearchParams(window.location.search).get("joinWorld") ?? "";
        if (requestedWorldId && allWorlds.some((world) => world.id === requestedWorldId)) return requestedWorldId;
        return worldList.currentWorldId || allWorlds[0]?.id || "";
      });
    } catch (err) {
      console.warn("[JoinGate] Failed to load user character choices:", err);
    }
  }, []);

  useEffect(() => {
    void refreshChoices();
  }, [refreshChoices]);

  useEffect(() => {
    const onConnected = () => {
      setConnecting(false);
      setError("");
      setVisible(false);
    };
    const onRejected = (data: { reason?: string }) => {
      setConnecting(false);
      setError(
        data?.reason === "invalid_code"
          ? "邀请码错误，请向房主确认后重试"
          : "加入失败，请重试",
      );
      setVisible(true);
    };
    const onKicked = () => {
      setConnecting(false);
      setError("你已被世界拥有者请出当前世界。");
      setVisible(true);
    };
    eventBus.on("network_connected", onConnected);
    eventBus.on("join_rejected", onRejected);
    eventBus.on("player_kicked", onKicked);
    return () => {
      eventBus.off("network_connected", onConnected);
      eventBus.off("join_rejected", onRejected);
      eventBus.off("player_kicked", onKicked);
    };
  }, [eventBus]);

  const handleSubmit = useCallback(async () => {
    if (!selectedCharacterId) {
      setError("当前账号没有可用角色。新账号应自带默认角色；如为旧账号数据，请先联系管理员补齐。");
      return;
    }
    if (!selectedWorldId) {
      setError("请选择要进入的世界");
      return;
    }
    setError("");
    setConnecting(true);
    try {
      const character = characters.find((item) => item.id === selectedCharacterId) ?? null;
      if (!character) {
        setError("请选择一个已有角色。新角色可进入游戏后在“我的角色”中创建。");
        setConnecting(false);
        return;
      }
      const entered = await apiClient.enterWorldWithUserCharacter(character.id, selectedWorldId);
      networkManager.setIdentity(entered.character.name, code);
      networkManager.setSelectedUserCharacter(entered.character.id, entered.character.name);
      networkManager.reconnect();
      if (entered.requiresReload) {
        setTimeout(() => window.location.reload(), 100);
      }
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [characters, code, selectedCharacterId, selectedWorldId]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(8, 12, 20, 0.72)",
        backdropFilter: "blur(6px)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          width: 360,
          maxWidth: "90vw",
          padding: "28px 26px",
          borderRadius: 16,
          background: "#161b26",
          border: "1px solid #2a3242",
          boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
          color: "#e8edf5",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700 }}>
          进入世界
        </h2>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#8b94a6" }}>
          选择一个世界和一个账号角色。进入世界后会自动落到该世界的默认地图节点。
        </p>

        <label style={labelStyle}>进入世界</label>
        <select
          value={selectedWorldId}
          onChange={(e) => setSelectedWorldId(e.target.value)}
          style={inputStyle}
          disabled={worlds.length === 0}
        >
          {worlds.length === 0 ? (
            <option value="">当前账号没有可进入的世界</option>
          ) : worlds.map((world) => (
            <option key={world.id} value={world.id}>{world.worldName}</option>
          ))}
        </select>

        <label style={{ ...labelStyle, marginTop: 16 }}>我的角色</label>
        <select
          value={selectedCharacterId}
          onChange={(e) => setSelectedCharacterId(e.target.value)}
          style={inputStyle}
          disabled={characters.length === 0}
        >
          {characters.length === 0 ? (
            <option value="">当前账号没有可用角色</option>
          ) : characters.map((character) => (
            <option key={character.id} value={character.id}>{character.name}</option>
          ))}
        </select>

        <label style={{ ...labelStyle, marginTop: 16 }}>
          房间邀请码 <span style={{ color: "#5b6478" }}>（开放房间可留空）</span>
        </label>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="向房主索取"
          style={inputStyle}
        />

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, color: "#ff8080" }}>{error}</div>
        )}

        <button
          onClick={handleSubmit}
          disabled={connecting}
          style={{
            marginTop: 22,
            width: "100%",
            padding: "11px 0",
            borderRadius: 10,
            border: "none",
            background: connecting ? "#3a4252" : "#4f7cff",
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            cursor: connecting ? "default" : "pointer",
          }}
        >
          {connecting ? "进入中…" : "进入世界"}
        </button>
      </div>
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#9aa3b5",
  marginBottom: 6,
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #2f3849",
  background: "#0f131c",
  color: "#e8edf5",
  fontSize: 14,
  outline: "none",
};
