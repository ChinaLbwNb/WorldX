import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type Phaser from "phaser";
import { apiClient } from "../services/api-client";
import { networkManager } from "../../systems/NetworkManager";
import type { CharacterInfo } from "../../types/api";

type ChatItem =
  | { id: string; kind: "player"; name: string; text: string; self: boolean }
  | { id: string; kind: "npc"; name: string; text: string }
  | { id: string; kind: "system"; text: string };

let seq = 0;
const nextId = () => `msg_${++seq}`;

export function PublicChatPanel({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [typingNpcs, setTypingNpcs] = useState<Record<string, string>>({}); // characterId -> name
  const [draft, setDraft] = useState("");
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [unread, setUnread] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const myName = networkManager.getStoredName() || "我";

  // 载入角色列表（用于 @ 匹配与补全），定期刷新
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiClient
        .getCharacters()
        .then((list) => !cancelled && setCharacters(list))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const append = useCallback(
    (item: ChatItem) => {
      setItems((prev) => [...prev, item].slice(-200));
      if (!open) setUnread((u) => u + 1);
    },
    [open],
  );

  // 订阅多人 / NPC 消息
  useEffect(() => {
    const onPlayerChat = (d: { playerId: string; playerName: string; message: string }) => {
      append({ id: nextId(), kind: "player", name: d.playerName, text: d.message, self: false });
    };
    const onNpcTyping = (d: { characterId: string; characterName: string }) => {
      setTypingNpcs((prev) => ({ ...prev, [d.characterId]: d.characterName }));
    };
    const onNpcChat = (d: { characterId: string; characterName: string; message: string }) => {
      setTypingNpcs((prev) => {
        const next = { ...prev };
        delete next[d.characterId];
        return next;
      });
      append({ id: nextId(), kind: "npc", name: d.characterName, text: d.message });
    };
    const onNpcError = (d: { characterId: string; characterName: string; reason: string }) => {
      setTypingNpcs((prev) => {
        const next = { ...prev };
        delete next[d.characterId];
        return next;
      });
      append({ id: nextId(), kind: "system", text: `${d.characterName} 没能回应（${d.reason}）` });
    };

    eventBus.on("player_chat", onPlayerChat);
    eventBus.on("npc_typing", onNpcTyping);
    eventBus.on("npc_chat", onNpcChat);
    eventBus.on("npc_chat_error", onNpcError);
    return () => {
      eventBus.off("player_chat", onPlayerChat);
      eventBus.off("npc_typing", onNpcTyping);
      eventBus.off("npc_chat", onNpcChat);
      eventBus.off("npc_chat_error", onNpcError);
    };
  }, [eventBus, append]);

  // 自动滚到底
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items, typingNpcs, open]);

  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  // @ 补全候选：取最后一个 @ 之后的文本做前缀匹配
  const mentionQuery = useMemo(() => {
    const at = draft.lastIndexOf("@");
    if (at < 0) return null;
    const after = draft.slice(at + 1);
    // @ 后若已有空格，视为补全结束
    if (/\s/.test(after)) return null;
    return { at, text: after };
  }, [draft]);

  const suggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.text.toLowerCase();
    return characters
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, characters]);

  const applyMention = (c: CharacterInfo) => {
    if (!mentionQuery) return;
    const before = draft.slice(0, mentionQuery.at);
    setDraft(`${before}@${c.name} `);
    inputRef.current?.focus();
  };

  /** 在文本里找出第一个匹配到的 NPC（按名字最长优先，避免短名误命中） */
  const matchNpc = (text: string): CharacterInfo | null => {
    const hit = characters
      .filter((c) => text.includes(`@${c.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    return hit ?? null;
  };

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");

    const npc = matchNpc(text);
    if (npc) {
      // 本地回显玩家提问
      append({ id: nextId(), kind: "player", name: myName, text, self: true });
      // 去掉 @名字 作为给 NPC 的问题
      const question = text.replace(`@${npc.name}`, "").trim() || text;
      networkManager.sendNpcChat(npc.id, question);
    } else {
      append({ id: nextId(), kind: "player", name: myName, text, self: true });
      networkManager.sendChat(text);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // 防止 Phaser 抢键盘
    if (e.key === "Enter") {
      e.preventDefault();
      if (mentionQuery && suggestions.length > 0) {
        applyMention(suggestions[0]);
        return;
      }
      handleSend();
    }
  };

  const typingList = Object.values(typingNpcs);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={launcherStyle}>
        💬 公屏
        {unread > 0 && <span style={badgeStyle}>{unread > 99 ? "99+" : unread}</span>}
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>💬 公屏聊天</span>
        <span style={{ fontSize: 10, opacity: 0.5, marginLeft: "auto", marginRight: 8 }}>
          @角色名 可与 AI 对话
        </span>
        <button onClick={() => setOpen(false)} style={iconBtnStyle} title="收起">
          —
        </button>
      </div>

      <div ref={scrollRef} style={scrollStyle}>
        {items.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 12, textAlign: "center", padding: 16 }}>
            说点什么吧。试试 <b>@</b> 一个 AI 角色聊天。
          </div>
        )}
        {items.map((m) => {
          if (m.kind === "system") {
            return (
              <div key={m.id} style={systemLineStyle}>
                {m.text}
              </div>
            );
          }
          const isNpc = m.kind === "npc";
          const isSelf = m.kind === "player" && m.self;
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: isSelf ? "flex-end" : "flex-start" }}>
              <span style={nameStyle(isNpc, isSelf)}>
                {isNpc ? `🤖 ${m.name}` : m.name}
              </span>
              <div style={bubbleStyle(isNpc, isSelf)}>{m.text}</div>
            </div>
          );
        })}
        {typingList.map((name) => (
          <div key={`typing_${name}`} style={{ display: "flex", flexDirection: "column" }}>
            <span style={nameStyle(true, false)}>🤖 {name}</span>
            <div style={{ ...bubbleStyle(true, false), fontStyle: "italic", opacity: 0.7 }}>
              正在输入…
            </div>
          </div>
        ))}
      </div>

      <div style={inputWrapStyle}>
        {mentionQuery && suggestions.length > 0 && (
          <div style={suggestBoxStyle}>
            {suggestions.map((c) => (
              <div key={c.id} style={suggestItemStyle} onMouseDown={(e) => { e.preventDefault(); applyMention(c); }}>
                🤖 {c.name}
              </div>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息，@角色名 与 AI 对话"
          style={inputStyle}
          maxLength={300}
        />
        <button onClick={handleSend} disabled={!draft.trim()} style={sendBtnStyle(!draft.trim())}>
          发送
        </button>
      </div>
    </div>
  );
}

// ---------- styles ----------
const panelStyle: CSSProperties = {
  position: "fixed",
  left: 16,
  bottom: 16,
  width: 340,
  height: "min(46vh, 460px)",
  display: "flex",
  flexDirection: "column",
  background: "linear-gradient(180deg, rgba(10,18,34,0.95), rgba(8,12,24,0.95))",
  border: "1px solid rgba(120,180,255,0.2)",
  borderRadius: 12,
  boxShadow: "0 16px 44px rgba(0,0,0,0.5)",
  color: "#e6ecf7",
  zIndex: 450,
  pointerEvents: "auto",
  overflow: "hidden",
};

const launcherStyle: CSSProperties = {
  position: "fixed",
  left: 16,
  bottom: 16,
  zIndex: 450,
  pointerEvents: "auto",
  background: "linear-gradient(135deg, #3a6dc9, #4a8bff)",
  color: "#fff",
  border: "none",
  borderRadius: 22,
  padding: "10px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const badgeStyle: CSSProperties = {
  background: "#ff4d4f",
  color: "#fff",
  borderRadius: 10,
  padding: "0 6px",
  fontSize: 11,
  minWidth: 16,
  textAlign: "center",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const iconBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "none",
  color: "#cdd6e6",
  width: 22,
  height: 22,
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const systemLineStyle: CSSProperties = {
  fontSize: 11,
  color: "#8b95a8",
  textAlign: "center",
  fontStyle: "italic",
};

const nameStyle = (isNpc: boolean, isSelf: boolean): CSSProperties => ({
  fontSize: 11,
  color: isNpc ? "#ffcf6a" : isSelf ? "#7fb0ff" : "#9aa6bd",
  marginBottom: 2,
  padding: "0 2px",
});

const bubbleStyle = (isNpc: boolean, isSelf: boolean): CSSProperties => ({
  maxWidth: "80%",
  padding: "6px 10px",
  borderRadius: isSelf ? "10px 10px 2px 10px" : "10px 10px 10px 2px",
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: isNpc
    ? "rgba(255,196,86,0.12)"
    : isSelf
      ? "linear-gradient(135deg, #3a6dc9, #4a8bff)"
      : "rgba(255,255,255,0.07)",
  color: isNpc ? "#ffe6b0" : isSelf ? "#fff" : "#e2e8f4",
  border: isNpc ? "1px solid rgba(255,196,86,0.25)" : "none",
});

const inputWrapStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  gap: 8,
  padding: 10,
  borderTop: "1px solid rgba(255,255,255,0.08)",
};

const inputStyle: CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(120,180,255,0.25)",
  borderRadius: 8,
  color: "#e8edf7",
  padding: "8px 10px",
  fontSize: 13,
  outline: "none",
};

const sendBtnStyle = (disabled: boolean): CSSProperties => ({
  background: disabled ? "rgba(120,180,255,0.2)" : "linear-gradient(135deg, #4a8bff, #6aa7ff)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "0 14px",
  fontSize: 13,
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
});

const suggestBoxStyle: CSSProperties = {
  position: "absolute",
  left: 10,
  right: 10,
  bottom: "100%",
  marginBottom: 6,
  background: "#10182a",
  border: "1px solid rgba(120,180,255,0.3)",
  borderRadius: 8,
  overflow: "hidden",
  boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
};

const suggestItemStyle: CSSProperties = {
  padding: "7px 10px",
  fontSize: 13,
  cursor: "pointer",
  color: "#dfe6f3",
};
