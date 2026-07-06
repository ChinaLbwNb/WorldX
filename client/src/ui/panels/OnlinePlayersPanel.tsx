import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { apiClient, type OnlinePlayerInfo, type OnlinePlayersResponse, type WorldMemberInfo } from "../services/api-client";
import { networkManager } from "../../systems/NetworkManager";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";

export function OnlinePlayersPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<OnlinePlayersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPlayerId, setBusyPlayerId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [members, setMembers] = useState<WorldMemberInfo[]>([]);
  const [busyMemberId, setBusyMemberId] = useState("");
  const userCharacterId = useMemo(
    () => networkManager.getSelectedUserCharacterId() || networkManager.getPlayerId() || "",
    [],
  );
  const { zIndex, bringToFront } = useFloatingWindowZIndex(true, 840);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextState = await apiClient.getOnlinePlayers(userCharacterId || undefined);
      setState(nextState);
      if (nextState.canManage && nextState.worldId) {
        const response = await apiClient.getWorldMembers(nextState.worldId);
        setMembers(response.members);
      } else {
        setMembers([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userCharacterId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const invite = async (player: OnlinePlayerInfo) => {
    if (!state?.canManage || !userCharacterId || player.isSelf || busyPlayerId) return;
    setBusyPlayerId(player.playerId);
    setError("");
    setNotice("");
    try {
      await apiClient.inviteOnlinePlayer({
        userCharacterId,
        targetPlayerId: player.playerId,
        role: "viewer",
      });
      setNotice(`已向 ${player.playerName || "该玩家"} 发送进入世界请求。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPlayerId("");
    }
  };

  const removeMember = async (member: WorldMemberInfo) => {
    if (!state?.worldId || busyMemberId) return;
    const ok = window.confirm(`移除成员 ${member.userId}？`);
    if (!ok) return;
    setBusyMemberId(member.userId);
    setError("");
    setNotice("");
    try {
      await apiClient.removeWorldMember(state.worldId, member.userId);
      setNotice(`已移除成员：${member.userId}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMemberId("");
    }
  };

  const currentPlayers = state?.players ?? [];
  const allPlayers = state?.allPlayers ?? currentPlayers;
  const discoverablePlayers = allPlayers.filter((player) => !player.isSelf);

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>在线玩家</div>
          <div style={subtitleStyle}>
            {loading && allPlayers.length === 0 ? "加载中..." : `${allPlayers.length} 人正在玩`}
          </div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭">×</button>
      </header>

      <section style={inviteStyle}>
        <div style={sectionTitleStyle}>邀请到我的世界</div>
        <div style={inviteTextStyle}>
          {state?.canManage
            ? "从全平台在线玩家中选择一个人，对方会收到确认弹窗；接受后会自动进入你的当前世界。"
            : "只有世界拥有者或管理员可以向其他在线玩家发出进入请求。"}
        </div>
      </section>

      {notice && <div style={noticeStyle}>{notice}</div>}
      {error && <div style={errorStyle}>{error}</div>}

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <span style={sectionTitleStyle}>所有在线玩家</span>
          <span style={countStyle}>{discoverablePlayers.length}</span>
        </div>
        <div style={listStyle}>
          {discoverablePlayers.length === 0 && !loading && (
            <div style={emptyStyle}>现在没有其他在线玩家。</div>
          )}
          {discoverablePlayers.map((player) => {
            const alreadyHere = player.worldId === state?.worldId;
            const disabled = !state?.canManage || alreadyHere || busyPlayerId === player.playerId || !userCharacterId;
            return (
              <div key={player.playerId} style={rowStyle}>
                <div style={avatarStyle}>{player.playerName.slice(0, 1) || "玩"}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={nameStyle}>{player.playerName || "未命名玩家"}</div>
                  <div style={metaStyle}>
                    {alreadyHere ? "已在当前世界" : `正在其他世界：${player.worldId}`}
                  </div>
                </div>
                <button
                  onClick={() => void invite(player)}
                  disabled={disabled}
                  style={primaryButtonStyle(disabled)}
                  title={alreadyHere ? "对方已经在当前世界" : "发送进入世界请求"}
                >
                  {busyPlayerId === player.playerId ? "发送中" : alreadyHere ? "已在" : "邀请"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <span style={sectionTitleStyle}>当前世界在线</span>
          <span style={countStyle}>{currentPlayers.length}</span>
        </div>
        <div style={listStyle}>
          {currentPlayers.length === 0 && !loading && (
            <div style={emptyStyle}>当前世界没有在线玩家。</div>
          )}
          {currentPlayers.map((player) => (
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
      </section>

      {state?.canManage && (
        <section style={membersStyle}>
          <div style={sectionTitleStyle}>世界成员</div>
          {members.length === 0 ? (
            <div style={emptyStyle}>还没有授权成员。在线邀请被接受后会自动加入成员。</div>
          ) : (
            <div style={listStyle}>
              {members.map((member) => (
                <div key={member.userId} style={memberRowStyle}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={nameStyle}>{member.userId}</div>
                    <div style={metaStyle}>{roleLabel(member.role)}</div>
                  </div>
                  <button
                    onClick={() => void removeMember(member)}
                    disabled={busyMemberId === member.userId}
                    style={kickButtonStyle(busyMemberId === member.userId)}
                    title="移除世界成员"
                  >
                    {busyMemberId === member.userId ? "移除中" : "移除"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "admin":
      return "管理";
    case "builder":
      return "共建";
    case "viewer":
      return "只读";
    case "owner":
      return "房主";
    default:
      return role || "成员";
  }
}

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(620, 9000),
  maxHeight: "min(760px, calc(100vh - 32px))",
  overflow: "auto",
  padding: 16,
  background: "rgba(18, 22, 34, 0.96)",
};

const headerStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 };
const titleStyle: CSSProperties = { fontSize: 18, fontWeight: 800 };
const subtitleStyle: CSSProperties = { marginTop: 3, fontSize: 12, color: "rgba(238,244,255,0.58)" };
const closeButtonStyle: CSSProperties = { width: 32, height: 32, borderRadius: 8, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.08)", color: "#fff", cursor: "pointer", fontSize: 20 };
const inviteStyle: CSSProperties = { display: "grid", gap: 6, padding: 10, borderRadius: 10, background: "rgba(116,185,255,0.08)", border: "1px solid rgba(116,185,255,0.16)", marginBottom: 10 };
const inviteTextStyle: CSSProperties = { fontSize: 12, lineHeight: 1.45, color: "rgba(238,244,255,0.68)" };
const sectionStyle: CSSProperties = { display: "grid", gap: 8, marginTop: 12 };
const sectionHeaderStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const sectionTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 900, color: "#dff3ff" };
const countStyle: CSSProperties = { fontSize: 11, color: "rgba(238,244,255,0.5)" };
const primaryButtonStyle = (disabled: boolean): CSSProperties => ({ border: "1px solid rgba(116,185,255,0.52)", background: "rgba(116,185,255,0.18)", color: "#dff3ff", borderRadius: 999, padding: "7px 12px", fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, whiteSpace: "nowrap" });
const noticeStyle: CSSProperties = { margin: "8px 0", padding: 9, borderRadius: 8, background: "rgba(85,239,196,0.1)", border: "1px solid rgba(85,239,196,0.22)", color: "#bdf8df", fontSize: 12 };
const errorStyle: CSSProperties = { margin: "8px 0", padding: 9, borderRadius: 8, background: "rgba(255,118,117,0.1)", border: "1px solid rgba(255,118,117,0.24)", color: "#ffb8b8", fontSize: 12 };
const listStyle: CSSProperties = { display: "grid", gap: 8 };
const emptyStyle: CSSProperties = { padding: 18, textAlign: "center", color: "rgba(238,244,255,0.55)", fontSize: 13 };
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" };
const avatarStyle: CSSProperties = { width: 34, height: 34, borderRadius: 999, display: "grid", placeItems: "center", background: "rgba(162,155,254,0.18)", border: "1px solid rgba(162,155,254,0.24)", color: "#e8e4ff", fontWeight: 800 };
const nameStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tagStyle: CSSProperties = { fontSize: 10, padding: "2px 6px", borderRadius: 999, background: "rgba(85,239,196,0.12)", color: "#a8f5d6" };
const metaStyle: CSSProperties = { marginTop: 3, fontSize: 11, color: "rgba(238,244,255,0.55)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const kickButtonStyle = (busy: boolean): CSSProperties => ({ border: "1px solid rgba(255,118,117,0.36)", background: "rgba(255,118,117,0.12)", color: "#ffd0d0", borderRadius: 999, padding: "7px 10px", fontSize: 12, fontWeight: 800, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 });
const membersStyle: CSSProperties = { marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.1)", display: "grid", gap: 8 };
const memberRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: 9, borderRadius: 10, background: "rgba(255,255,255,0.045)", border: "1px solid rgba(255,255,255,0.08)" };
