import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { apiClient, type OnlinePlayerInfo, type OnlinePlayersResponse } from "../services/api-client";

export function OnlinePlayersPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<OnlinePlayersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPlayerId, setBusyPlayerId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manualInviteUrl, setManualInviteUrl] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setState(await apiClient.getOnlinePlayers());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const inviteUrl = useMemo(() => {
    if (!state?.worldId) return "";
    const url = new URL(window.location.href);
    url.pathname = "/";
    url.searchParams.set("joinWorld", state.worldId);
    url.searchParams.delete("mode");
    url.searchParams.delete("dev");
    return url.toString();
  }, [state?.worldId]);

  const copyInvite = async () => {
    if (!state?.worldId || !inviteUrl) return;
    setError("");
    setNotice("");
    try {
      if (state.canManage) {
        await apiClient.updateWorldVisibility(state.worldId, "unlisted");
      }
      const copied = await copyText(inviteUrl);
      setManualInviteUrl(copied ? "" : inviteUrl);
      setNotice(copied
        ? "已复制邀请链接。世界已设为不公开可访问。"
        : "邀请链接已生成。当前浏览器禁止自动复制，请手动复制下方链接。");
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const kick = async (player: OnlinePlayerInfo) => {
    if (!state?.canManage || player.isSelf || busyPlayerId) return;
    const ok = window.confirm(`踢出 ${player.playerName || "该玩家"}？`);
    if (!ok) return;
    setBusyPlayerId(player.playerId);
    setError("");
    setNotice("");
    try {
      await apiClient.kickOnlinePlayer(player.playerId);
      setNotice(`已踢出：${player.playerName || player.playerId}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPlayerId("");
    }
  };

  const players = state?.players ?? [];

  return (
    <aside style={panelStyle}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>在线玩家</div>
          <div style={subtitleStyle}>
            {loading && players.length === 0 ? "加载中..." : `${players.length} 人在线`}
          </div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭">×</button>
      </header>

      <section style={inviteStyle}>
        <button
          onClick={() => void copyInvite()}
          disabled={!state?.worldId}
          style={primaryButtonStyle(!state?.worldId)}
          title="复制当前世界邀请链接"
        >
          邀请
        </button>
        <div style={inviteTextStyle}>
          {state?.canManage
            ? "复制链接后，别人登录账号即可从链接进入你的世界。"
            : "只有世界拥有者可以生成邀请链接和踢人。"}
        </div>
      </section>

      {notice && <div style={noticeStyle}>{notice}</div>}
      {error && <div style={errorStyle}>{error}</div>}
      {manualInviteUrl && (
        <input
          value={manualInviteUrl}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
          style={manualLinkStyle}
          title="邀请链接"
        />
      )}

      <div style={listStyle}>
        {players.length === 0 && !loading && (
          <div style={emptyStyle}>当前没有在线玩家。</div>
        )}
        {players.map((player) => (
          <div key={player.playerId} style={rowStyle}>
            <div style={avatarStyle}>{player.playerName.slice(0, 1) || "玩"}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={nameStyle}>
                {player.playerName || "未命名玩家"}
                {player.isSelf && <span style={tagStyle}>我</span>}
              </div>
              <div style={metaStyle}>
                {player.isCurrentMap ? "当前地图" : `其他地图：${player.mapId}`}
              </div>
            </div>
            {state?.canManage && !player.isSelf && (
              <button
                onClick={() => void kick(player)}
                disabled={busyPlayerId === player.playerId}
                style={kickButtonStyle(busyPlayerId === player.playerId)}
                title="踢出当前世界"
              >
                {busyPlayerId === player.playerId ? "踢出中" : "踢出"}
              </button>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy focused-textarea path.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  return ok;
}

const panelStyle: CSSProperties = {
  position: "fixed",
  top: 96,
  right: 24,
  zIndex: 9000,
  width: 360,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "calc(100vh - 132px)",
  overflow: "auto",
  padding: 16,
  borderRadius: 12,
  background: "rgba(18, 22, 34, 0.96)",
  border: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
  color: "#eef4ff",
  fontFamily: "system-ui, sans-serif",
  pointerEvents: "auto",
};

const headerStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 };
const titleStyle: CSSProperties = { fontSize: 18, fontWeight: 800 };
const subtitleStyle: CSSProperties = { marginTop: 3, fontSize: 12, color: "rgba(238,244,255,0.58)" };
const closeButtonStyle: CSSProperties = { width: 32, height: 32, borderRadius: 8, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.08)", color: "#fff", cursor: "pointer", fontSize: 20 };
const inviteStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, background: "rgba(116,185,255,0.08)", border: "1px solid rgba(116,185,255,0.16)", marginBottom: 10 };
const inviteTextStyle: CSSProperties = { fontSize: 12, lineHeight: 1.45, color: "rgba(238,244,255,0.68)" };
const primaryButtonStyle = (disabled: boolean): CSSProperties => ({ border: "1px solid rgba(116,185,255,0.52)", background: "rgba(116,185,255,0.18)", color: "#dff3ff", borderRadius: 999, padding: "8px 14px", fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 });
const noticeStyle: CSSProperties = { margin: "8px 0", padding: 9, borderRadius: 8, background: "rgba(85,239,196,0.1)", border: "1px solid rgba(85,239,196,0.22)", color: "#bdf8df", fontSize: 12 };
const errorStyle: CSSProperties = { margin: "8px 0", padding: 9, borderRadius: 8, background: "rgba(255,118,117,0.1)", border: "1px solid rgba(255,118,117,0.24)", color: "#ffb8b8", fontSize: 12 };
const manualLinkStyle: CSSProperties = { width: "100%", boxSizing: "border-box", margin: "0 0 10px", padding: "9px 10px", borderRadius: 8, border: "1px solid rgba(116,185,255,0.24)", background: "rgba(5,8,14,0.46)", color: "#dff3ff", fontSize: 12 };
const listStyle: CSSProperties = { display: "grid", gap: 8 };
const emptyStyle: CSSProperties = { padding: 18, textAlign: "center", color: "rgba(238,244,255,0.55)", fontSize: 13 };
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" };
const avatarStyle: CSSProperties = { width: 34, height: 34, borderRadius: 999, display: "grid", placeItems: "center", background: "rgba(162,155,254,0.18)", border: "1px solid rgba(162,155,254,0.24)", color: "#e8e4ff", fontWeight: 800 };
const nameStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tagStyle: CSSProperties = { fontSize: 10, padding: "2px 6px", borderRadius: 999, background: "rgba(85,239,196,0.12)", color: "#a8f5d6" };
const metaStyle: CSSProperties = { marginTop: 3, fontSize: 11, color: "rgba(238,244,255,0.55)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const kickButtonStyle = (busy: boolean): CSSProperties => ({ border: "1px solid rgba(255,118,117,0.36)", background: "rgba(255,118,117,0.12)", color: "#ffd0d0", borderRadius: 999, padding: "7px 10px", fontSize: 12, fontWeight: 800, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 });
