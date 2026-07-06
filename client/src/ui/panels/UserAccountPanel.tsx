import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { networkManager } from "../../systems/NetworkManager";
import { apiClient, type AuthUserInfo } from "../services/api-client";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";

export function UserAccountPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [authUser, setAuthUser] = useState<AuthUserInfo | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);

  const refresh = useCallback(async () => {
    if (!open || !networkManager.getAuthToken()) {
      setAuthUser(null);
      return;
    }
    try {
      const response = await apiClient.getAuthMe();
      setAuthUser(response.user);
      networkManager.setUserId(response.user.id);
    } catch {
      setAuthUser(null);
    }
  }, [open]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!open) return null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = mode === "register"
        ? await apiClient.register({
          username,
          password,
          displayName: displayName.trim() || username,
        })
        : await apiClient.login({ username, password });
      networkManager.setAuthSession(response.user.id, response.token);
      networkManager.clearSelectedUserCharacter();
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await apiClient.logout().catch(() => undefined);
      networkManager.clearAuthSession();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!authUser || busy) return;
    const confirmed = window.confirm("删除当前账号？这会删除账号下的角色、物品、资源、世界索引和会话。此操作不能撤销。");
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await apiClient.deleteUser(authUser.id);
      networkManager.clearAuthSession();
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>账号</div>
          <div style={subtitleStyle}>
            {authUser ? `${authUser.displayName} · ${authUser.username}` : "登录后隔离你的世界、角色和物品"}
          </div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭账号面板">x</button>
      </header>

      {authUser ? (
        <section style={bodyStyle}>
          <div style={accountCardStyle}>
            <strong>{authUser.displayName}</strong>
            <span>{authUser.id}</span>
          </div>
          <button onClick={() => void logout()} disabled={busy} style={primaryButtonStyle}>
            退出登录
          </button>
          <button onClick={() => void deleteAccount()} disabled={busy} style={dangerButtonStyle}>
            删除账号
          </button>
          {error && <div style={errorStyle}>{error}</div>}
        </section>
      ) : (
        <section style={bodyStyle}>
          <div style={tabsStyle}>
            <button type="button" onClick={() => setMode("login")} style={tabStyle(mode === "login")}>登录</button>
            <button type="button" onClick={() => setMode("register")} style={tabStyle(mode === "register")}>注册</button>
          </div>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="用户名"
            style={inputStyle}
            autoComplete="username"
          />
          {mode === "register" && (
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="显示名称，可留空"
              style={inputStyle}
              autoComplete="nickname"
            />
          )}
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="密码"
            type="password"
            style={inputStyle}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {error && <div style={errorStyle}>{error}</div>}
          <button onClick={() => void submit()} disabled={busy} style={primaryButtonStyle}>
            {busy ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
          </button>
          <p style={hintStyle}>
            账号会成为世界、角色和物品的归属边界。进入别人世界需要对方世界开放或后续邀请授权。
          </p>
        </section>
      )}
    </aside>
  );
}

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(420, 840),
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 14px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const bodyStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  padding: 14,
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
  fontSize: 18,
  lineHeight: "26px",
};

const tabsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};

const tabStyle = (active: boolean): CSSProperties => ({
  height: 32,
  border: "1px solid rgba(255,255,255,0.14)",
  background: active ? "rgba(88,172,255,0.28)" : "rgba(255,255,255,0.07)",
  color: "#eef4ff",
  cursor: "pointer",
});

const inputStyle: CSSProperties = {
  minWidth: 0,
  height: 36,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(0,0,0,0.22)",
  color: "#eef4ff",
  padding: "0 10px",
  outline: "none",
  fontSize: 13,
};

const primaryButtonStyle: CSSProperties = {
  height: 38,
  border: "1px solid rgba(125,212,255,0.42)",
  background: "rgba(88,172,255,0.24)",
  color: "#eef8ff",
  padding: "0 12px",
  fontWeight: 700,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  height: 38,
  border: "1px solid rgba(255,120,120,0.42)",
  background: "rgba(255,76,76,0.14)",
  color: "#ffd0d0",
  padding: "0 12px",
  fontWeight: 700,
  cursor: "pointer",
};

const accountCardStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: 12,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.06)",
  fontSize: 13,
};

const hintStyle: CSSProperties = {
  margin: 0,
  color: "rgba(238,244,255,0.58)",
  fontSize: 12,
  lineHeight: 1.5,
};

const errorStyle: CSSProperties = {
  padding: "8px 10px",
  border: "1px solid rgba(255,99,99,0.35)",
  background: "rgba(255,76,76,0.12)",
  color: "#ffb1b1",
  fontSize: 12,
};
