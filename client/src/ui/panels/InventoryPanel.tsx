import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type Phaser from "phaser";
import { networkManager } from "../../systems/NetworkManager";
import { apiClient, type InventoryItemInfo } from "../services/api-client";

export function InventoryPanel({
  open,
  onClose,
  eventBus,
}: {
  open: boolean;
  onClose: () => void;
  eventBus: Phaser.Events.EventEmitter;
}) {
  const [items, setItems] = useState<InventoryItemInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deletingEntryId, setDeletingEntryId] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const userCharacterId = useMemo(() => networkManager.getSelectedUserCharacterId() || networkManager.getPlayerId() || "", [open]);

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError("");
    try {
      const response = await apiClient.getAccountInventory();
      setItems(response.items);
      setSelectedEntryId((current) => response.items.some((item) => item.entryId === current) ? current : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onInventoryChanged = () => {
      void refresh();
    };
    eventBus.on("inventory_changed", onInventoryChanged);
    return () => {
      eventBus.off("inventory_changed", onInventoryChanged);
    };
  }, [eventBus, open, refresh]);

  if (!open) return null;

  const generateItem = async () => {
    if (generating) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("请输入想生成的物品，例如：一张宋朝酒肆木桌。");
      return;
    }
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const response = await apiClient.generateInventoryItem({
        userCharacterId,
        prompt: trimmed,
      });
      setPrompt("");
      setNotice(`已生成：${response.item.name}`);
      eventBus.emit("item_generated", {
        resources: response.resources,
        cost: response.cost,
        item: response.item,
      });
      eventBus.emit("inventory_changed");
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message.startsWith("物品生成失败") ? message : `物品生成失败：${message}`);
    } finally {
      setGenerating(false);
    }
  };

  const startPlacement = (item: InventoryItemInfo) => {
    eventBus.emit("begin_item_placement", { item });
    onClose();
  };

  const deleteItem = async (item: InventoryItemInfo) => {
    if (deletingEntryId) return;
    const confirmed = window.confirm(`删除“${item.name}”？这个操作不能撤销。`);
    if (!confirmed) return;
    setDeletingEntryId(item.entryId);
    setError("");
    setNotice("");
    try {
      await apiClient.deleteInventoryItem({
        userCharacterId,
        entryId: item.entryId,
      });
      setSelectedEntryId("");
      setNotice(`已删除：${item.name}`);
      eventBus.emit("inventory_changed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId("");
    }
  };

  const selectedItem = items.find((item) => item.entryId === selectedEntryId) ?? null;

  return (
    <aside style={panelStyle}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>背包</div>
          <div style={subtitleStyle}>{items.length} 件物品</div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭背包">×</button>
      </header>

      {loading && items.length === 0 && (
        <div style={emptyStyle}>加载中...</div>
      )}
      {(
        <section style={generatorStyle}>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void generateItem();
            }}
            placeholder="生成家具、小建筑或装饰物"
            style={inputStyle}
            maxLength={300}
          />
          <button
            onClick={() => void generateItem()}
            disabled={generating}
            style={{
              ...generateButtonStyle,
              opacity: generating ? 0.65 : 1,
              cursor: generating ? "default" : "pointer",
            }}
            title="消耗资源生成物品"
          >
            {generating ? "生成中" : "生成"}
          </button>
        </section>
      )}
      {notice && (
        <div style={noticeStyle}>{notice}</div>
      )}
      {error && (
        <div style={errorStyle}>{error}</div>
      )}
      {!loading && !error && items.length === 0 && (
        <div style={emptyStyle}>背包还是空的。输入想要的家具、小建筑或装饰物来生成。</div>
      )}
      {items.length > 0 && (
        <div style={inventoryBodyStyle}>
          <div style={gridStyle}>
          {items.map((item) => (
            <button
              key={item.entryId}
              type="button"
              onClick={() => setSelectedEntryId(item.entryId)}
              style={cellStyle(selectedEntryId === item.entryId)}
              title={item.description || item.name}
            >
              <div style={cellImageFrameStyle}>
                {assetUrlForItem(item) ? (
                  <img src={assetUrlForItem(item)} alt={item.name} style={cellImageStyle} draggable={false} />
                ) : (
                  <span style={cellFallbackIconStyle}>{iconForCategory(item.category)}</span>
                )}
              </div>
              <div style={cellNameStyle}>{item.name}</div>
              {item.quantity > 1 && <div style={cellQuantityStyle}>×{item.quantity}</div>}
            </button>
          ))}
          </div>
          {selectedItem && (
            <div style={actionPanelStyle}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={itemNameStyle}>{selectedItem.name}</div>
                <div style={itemMetaStyle}>
                  {categoryLabel(selectedItem.category)}
                  {selectedItem.placeable ? " · 可摆放" : ""}
                </div>
              </div>
              {selectedItem.placeable && (
                <button
                  onClick={() => startPlacement(selectedItem)}
                  style={placeButtonStyle}
                  title="在地图上摆放"
                >
                  摆放
                </button>
              )}
              <button
                onClick={() => void deleteItem(selectedItem)}
                disabled={deletingEntryId === selectedItem.entryId}
                style={deleteButtonStyle(deletingEntryId === selectedItem.entryId)}
                title="永久删除物品"
              >
                {deletingEntryId === selectedItem.entryId ? "删除中" : "删除"}
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function iconForCategory(category: string): string {
  switch (category) {
    case "food": return "🍱";
    case "tool": return "🛠";
    case "equipment": return "🛡";
    case "furniture": return "▥";
    case "decoration": return "▣";
    case "quest": return "!";
    case "container": return "▤";
    case "material":
    default:
      return "◇";
  }
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    material: "材料",
    tool: "工具",
    food: "食物",
    equipment: "装备",
    quest: "任务",
    furniture: "家具",
    decoration: "摆件",
    container: "容器",
    misc: "杂项",
  };
  return labels[category] ?? category;
}

function assetUrlForItem(item: InventoryItemInfo): string {
  const value = item.metadata?.assetUrl;
  return typeof value === "string" ? value : "";
}

const panelStyle: CSSProperties = {
  position: "fixed",
  right: 18,
  top: "calc(var(--top-ui-offset, 52px) + 14px)",
  width: 320,
  maxWidth: "calc(100vw - 36px)",
  maxHeight: "calc(100vh - var(--top-ui-offset, 52px) - 28px)",
  zIndex: 780,
  pointerEvents: "auto",
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(17, 22, 32, 0.94)",
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

const inventoryBodyStyle: CSSProperties = {
  padding: 12,
  overflowY: "auto",
  maxHeight: "calc(100vh - var(--top-ui-offset, 52px) - 96px)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
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

function cellStyle(selected: boolean): CSSProperties {
  return {
    position: "relative",
    height: 104,
    minWidth: 0,
    display: "grid",
    gridTemplateRows: "68px 1fr",
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

const cellImageFrameStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: "grid",
  placeItems: "center",
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(0,0,0,0.18)",
  overflow: "hidden",
};

const cellImageStyle: CSSProperties = {
  maxWidth: "92%",
  maxHeight: "92%",
  objectFit: "contain",
  imageRendering: "auto",
};

const cellFallbackIconStyle: CSSProperties = {
  fontSize: 24,
  color: "rgba(238,244,255,0.72)",
};

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

const cellQuantityStyle: CSSProperties = {
  position: "absolute",
  right: 7,
  top: 7,
  minWidth: 22,
  height: 18,
  padding: "0 5px",
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.55)",
  color: "#a6f0c6",
  fontSize: 11,
  fontWeight: 800,
};

const iconStyle: CSSProperties = {
  width: 34,
  height: 34,
  display: "grid",
  placeItems: "center",
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(111, 197, 255, 0.12)",
  fontSize: 17,
  flex: "0 0 auto",
};

const itemNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const itemMetaStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  color: "rgba(238,244,255,0.58)",
};

const placeButtonStyle: CSSProperties = {
  height: 28,
  border: "1px solid rgba(166,240,198,0.35)",
  background: "rgba(68,189,120,0.16)",
  color: "#c9f8d9",
  padding: "0 9px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  flex: "0 0 auto",
};

function deleteButtonStyle(busy: boolean): CSSProperties {
  return {
    height: 28,
    border: "1px solid rgba(255,120,120,0.38)",
    background: busy ? "rgba(255,120,120,0.08)" : "rgba(255,120,120,0.16)",
    color: "#ffd0d0",
    padding: "0 9px",
    fontSize: 12,
    fontWeight: 700,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.65 : 1,
    flex: "0 0 auto",
  };
}

const actionPanelStyle: CSSProperties = {
  marginTop: 10,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.2)",
};

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
