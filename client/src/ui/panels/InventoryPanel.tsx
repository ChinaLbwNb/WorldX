import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type Phaser from "phaser";
import { networkManager } from "../../systems/NetworkManager";
import { apiClient, type InventoryItemInfo, type ItemTransferInfo, type OnlinePlayerInfo } from "../services/api-client";
import type { BuildState } from "../../types/api";
import { withAssetAuth } from "../../utils/asset-url";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";
import { GenerationProgress, useLocalGenerationProgress } from "../components/GenerationProgress";

type TransferStatusFilter = "completed" | "cancelled" | "failed";

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
  const [onlinePlayers, setOnlinePlayers] = useState<OnlinePlayerInfo[]>([]);
  const [incomingTransfers, setIncomingTransfers] = useState<ItemTransferInfo[]>([]);
  const [outgoingTransfers, setOutgoingTransfers] = useState<ItemTransferInfo[]>([]);
  const [historyTransfers, setHistoryTransfers] = useState<ItemTransferInfo[]>([]);
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [historyStatus, setHistoryStatus] = useState<TransferStatusFilter>("completed");
  const [targetUserId, setTargetUserId] = useState("");
  const [targetTradeItems, setTargetTradeItems] = useState<InventoryItemInfo[]>([]);
  const [requestedEntryId, setRequestedEntryId] = useState("");
  const [loadingTradeItems, setLoadingTradeItems] = useState(false);
  const [transferBusyId, setTransferBusyId] = useState("");
  const [buildState, setBuildState] = useState<BuildState | null>(null);
  const userCharacterId = useMemo(() => networkManager.getSelectedUserCharacterId() || networkManager.getPlayerId() || "", [open]);
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);
  const itemGenerationProgress = useLocalGenerationProgress();

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError("");
    try {
      const [response, transfers, online] = await Promise.all([
        apiClient.getAccountInventory(),
        apiClient.getItemTransfers("requested"),
        apiClient.getOnlinePlayers(userCharacterId || undefined).catch(() => null),
      ]);
      const build = await apiClient.getBuildState(userCharacterId || undefined).catch(() => null);
      const history = await apiClient.getItemTransfers(historyStatus);
      setItems(response.items);
      setBuildState(build);
      setSelectedEntryId((current) => response.items.some((item) => item.entryId === current) ? current : "");
      setIncomingTransfers(transfers.incoming);
      setOutgoingTransfers(transfers.outgoing);
      setHistoryTransfers([...history.incoming, ...history.outgoing].slice(0, 12));
      const candidates = (online?.players ?? []).filter((player) => !player.isSelf && player.isCurrentMap);
      setOnlinePlayers(candidates);
      setTargetUserId((current) => {
        const next = candidates.some((player) => player.userId === current) ? current : candidates[0]?.userId ?? "";
        if (!next) {
          setTargetTradeItems([]);
          setRequestedEntryId("");
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [historyStatus, open, userCharacterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onInventoryChanged = () => {
      void refresh();
    };
    const onTransferChanged = () => {
      void refresh();
    };
    eventBus.on("inventory_changed", onInventoryChanged);
    eventBus.on("item_transfer_requested", onTransferChanged);
    eventBus.on("item_transfer_completed", onTransferChanged);
    eventBus.on("item_transfer_cancelled", onTransferChanged);
    return () => {
      eventBus.off("inventory_changed", onInventoryChanged);
      eventBus.off("item_transfer_requested", onTransferChanged);
      eventBus.off("item_transfer_completed", onTransferChanged);
      eventBus.off("item_transfer_cancelled", onTransferChanged);
    };
  }, [eventBus, open, refresh]);

  useEffect(() => {
    if (!open || !userCharacterId || !targetUserId) {
      setTargetTradeItems([]);
      setRequestedEntryId("");
      return;
    }
    let cancelled = false;
    setLoadingTradeItems(true);
    apiClient.getTradeCandidates({ userCharacterId, targetUserId })
      .then((response) => {
        if (cancelled) return;
        setTargetTradeItems(response.items);
        setRequestedEntryId((current) => response.items.some((item) => item.entryId === current)
          ? current
          : response.items[0]?.entryId ?? "");
      })
      .catch(() => {
        if (cancelled) return;
        setTargetTradeItems([]);
        setRequestedEntryId("");
      })
      .finally(() => {
        if (!cancelled) setLoadingTradeItems(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetUserId, userCharacterId]);

  if (!open) return null;

  const resources = buildState?.resources ?? 0;
  const itemCost = buildState?.costs.item ?? 8;
  const canAffordItem = resources >= itemCost;

  const generateItem = async () => {
    if (generating) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("请输入想生成的物品，例如：一张宋朝酒肆木桌。");
      return;
    }
    if (!userCharacterId) {
      setError("请先选择一个账号角色再生成物品。");
      return;
    }
    if (!canAffordItem) {
      setError(`资源不足：生成物品需要 💎 ${itemCost}，当前只有 💎 ${resources}。`);
      return;
    }
    setGenerating(true);
    setError("");
    setNotice("");
    itemGenerationProgress.start("开始生成物品：提交描述与账号上下文。");
    itemGenerationProgress.mark(22, "等待物品结构、透明素材和裁切处理。");
    try {
      const response = await apiClient.generateInventoryItem({
        userCharacterId,
        prompt: trimmed,
      });
      itemGenerationProgress.mark(86, "生成服务已返回，正在写入账号背包。");
      setPrompt("");
      setNotice(`已生成：${response.item.name}`);
      setBuildState((prev) => prev ? { ...prev, resources: response.resources } : prev);
      eventBus.emit("item_generated", {
        resources: response.resources,
        cost: response.cost,
        item: response.item,
      });
      eventBus.emit("inventory_changed");
      await refresh();
      itemGenerationProgress.finish(`完成：${response.item.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message.startsWith("物品生成失败") ? message : `物品生成失败：${message}`);
      itemGenerationProgress.fail(`失败：${message}`);
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

  const dropItem = async (item: InventoryItemInfo) => {
    if (deletingEntryId) return;
    const confirmed = window.confirm(`丢弃“${item.name}”？物品会离开背包。`);
    if (!confirmed) return;
    setDeletingEntryId(item.entryId);
    setError("");
    setNotice("");
    try {
      await apiClient.dropInventoryItem({
        userCharacterId,
        entryId: item.entryId,
      });
      setSelectedEntryId("");
      setNotice(`已丢弃：${item.name}`);
      eventBus.emit("inventory_changed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId("");
    }
  };

  const useItem = async (item: InventoryItemInfo) => {
    if (deletingEntryId) return;
    setDeletingEntryId(item.entryId);
    setError("");
    setNotice("");
    try {
      await apiClient.useInventoryItem({
        userCharacterId,
        entryId: item.entryId,
      });
      setSelectedEntryId("");
      setNotice(`已使用：${item.name}`);
      eventBus.emit("inventory_changed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId("");
    }
  };

  const requestTransfer = async (item: InventoryItemInfo) => {
    if (!targetUserId || transferBusyId) return;
    setTransferBusyId(item.entryId);
    setError("");
    setNotice("");
    try {
      await apiClient.requestItemTransfer({
        userCharacterId,
        entryId: item.entryId,
        targetUserId,
      });
      const target = onlinePlayers.find((player) => player.userId === targetUserId);
      setNotice(`已向 ${target?.playerName || "对方"} 发送赠送请求`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusyId("");
    }
  };

  const requestTrade = async (item: InventoryItemInfo) => {
    if (!targetUserId || !requestedEntryId || transferBusyId) return;
    setTransferBusyId(`trade:${item.entryId}`);
    setError("");
    setNotice("");
    try {
      await apiClient.requestItemTrade({
        userCharacterId,
        offerEntryId: item.entryId,
        targetUserId,
        requestedEntryId,
      });
      const target = onlinePlayers.find((player) => player.userId === targetUserId);
      const requested = targetTradeItems.find((candidate) => candidate.entryId === requestedEntryId);
      setNotice(`已向 ${target?.playerName || "对方"} 发起交换：用 ${item.name} 换 ${requested?.name || "对方物品"}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusyId("");
    }
  };

  const respondTransfer = async (transfer: ItemTransferInfo, accept: boolean) => {
    if (transferBusyId) return;
    setTransferBusyId(transfer.id);
    setError("");
    setNotice("");
    try {
      await apiClient.respondItemTransfer(transfer.id, accept);
      setNotice(accept
        ? transfer.kind === "trade"
          ? `已完成交换：${transfer.item?.name || "物品"}`
          : `已接收：${transfer.item?.name || "物品"}`
        : transfer.kind === "trade"
          ? "已拒绝交换请求"
          : "已拒绝赠送请求");
      eventBus.emit("inventory_changed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusyId("");
    }
  };

  const cancelTransfer = async (transfer: ItemTransferInfo) => {
    if (transferBusyId) return;
    setTransferBusyId(transfer.id);
    setError("");
    setNotice("");
    try {
      await apiClient.cancelItemTransfer(transfer.id);
      setNotice(transfer.kind === "trade" ? "已撤销交换请求" : "已撤销赠送请求");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusyId("");
    }
  };

  const selectedItem = items.find((item) => item.entryId === selectedEntryId) ?? null;

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
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
          <div style={costHintStyle(canAffordItem)}>
            <span>生成物品</span>
            <strong>💎 {itemCost}</strong>
            <span>当前 💎 {resources}</span>
          </div>
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
            disabled={generating || !canAffordItem}
            style={{
              ...generateButtonStyle,
              opacity: generating || !canAffordItem ? 0.65 : 1,
              cursor: generating || !canAffordItem ? "default" : "pointer",
            }}
            title={canAffordItem ? "消耗资源生成物品" : "资源不足，无法生成物品"}
          >
            {generating ? "生成中" : canAffordItem ? "生成" : "资源不足"}
          </button>
        </section>
      )}
      {itemGenerationProgress.active && (
        <GenerationProgress
          title="物品生成进度"
          progress={itemGenerationProgress.progress}
          logs={itemGenerationProgress.logs}
        />
      )}
      {notice && (
        <div style={noticeStyle}>{notice}</div>
      )}
      {error && (
        <div style={errorStyle}>{error}</div>
      )}
      {incomingTransfers.length > 0 && (
        <section style={transferPanelStyle}>
          <div style={transferTitleStyle}>收到的请求</div>
          {incomingTransfers.map((transfer) => (
            <div key={transfer.id} style={transferRowStyle}>
              <span style={transferItemNameStyle}>
                {transfer.kind === "trade"
                  ? `交换：${transfer.item?.name || "未知物品"} ⇄ ${stringMetadata(transfer.metadata, "requestedItemName") || nameForEntry(items, stringMetadata(transfer.metadata, "requestedEntryId")) || "你的物品"}`
                  : `赠送：${transfer.item?.name || "未知物品"}`}
              </span>
              <button
                onClick={() => void respondTransfer(transfer, true)}
                disabled={transferBusyId === transfer.id}
                style={miniActionButtonStyle(false)}
              >
                {transfer.kind === "trade" ? "交换" : "接收"}
              </button>
              <button
                onClick={() => void respondTransfer(transfer, false)}
                disabled={transferBusyId === transfer.id}
                style={miniActionButtonStyle(true)}
              >
                拒绝
              </button>
            </div>
          ))}
        </section>
      )}
      {outgoingTransfers.length > 0 && (
        <section style={transferPanelStyle}>
          <div style={transferTitleStyle}>发出的请求</div>
          {outgoingTransfers.map((transfer) => (
            <div key={transfer.id} style={transferRowStyle}>
              <span style={transferItemNameStyle}>
                {transfer.kind === "trade"
                  ? `交换：${transfer.item?.name || "未知物品"} ⇄ ${stringMetadata(transfer.metadata, "requestedItemName") || "对方物品"}`
                  : `赠送：${transfer.item?.name || "未知物品"}`}
              </span>
              <button
                onClick={() => void cancelTransfer(transfer)}
                disabled={transferBusyId === transfer.id}
                style={miniActionButtonStyle(true)}
              >
                撤销
              </button>
            </div>
          ))}
        </section>
      )}
      <section style={historyPanelStyle(historyCollapsed)}>
        <div style={historyHeaderStyle}>
          <span>交易历史</span>
          <div style={historyHeaderActionsStyle}>
            {!historyCollapsed && (
              <select
                value={historyStatus}
                onChange={(event) => setHistoryStatus(event.target.value as TransferStatusFilter)}
                style={historySelectStyle}
              >
                <option value="completed">已完成</option>
                <option value="cancelled">已取消</option>
                <option value="failed">已过期</option>
              </select>
            )}
            <button
              type="button"
              onClick={() => setHistoryCollapsed((value) => !value)}
              style={historyToggleButtonStyle}
              title={historyCollapsed ? "展开交易历史" : "收起交易历史"}
            >
              {historyCollapsed ? "展开" : "收起"}
            </button>
          </div>
        </div>
        {!historyCollapsed && (
          historyTransfers.length === 0 ? (
            <div style={historyEmptyStyle}>暂无记录</div>
          ) : (
            historyTransfers.map((transfer) => (
              <div key={transfer.id} style={historyRowStyle}>
                <span style={transferItemNameStyle}>
                  {transfer.kind === "trade" ? "交换" : transfer.kind === "gift" ? "赠送" : transfer.kind}
                  ：{transfer.item?.name || "未知物品"}
                </span>
                <span style={historyTimeStyle}>{shortDate(transfer.createdAt)}</span>
              </div>
            ))
          )
        )}
      </section>
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
              {isUsableItem(selectedItem) && (
                <button
                  onClick={() => void useItem(selectedItem)}
                  disabled={deletingEntryId === selectedItem.entryId}
                  style={placeButtonStyle}
                  title="使用物品"
                >
                  {deletingEntryId === selectedItem.entryId ? "处理中" : "使用"}
                </button>
              )}
              {onlinePlayers.length > 0 && (
                <div style={giftControlsStyle}>
                  <select
                    value={targetUserId}
                    onChange={(event) => setTargetUserId(event.target.value)}
                    style={giftSelectStyle}
                    title="选择同地图在线玩家"
                  >
                    {onlinePlayers.map((player) => (
                      <option key={`${player.userId}:${player.playerId}`} value={player.userId}>
                        {player.playerName || player.userId}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void requestTransfer(selectedItem)}
                    disabled={!targetUserId || transferBusyId === selectedItem.entryId}
                    style={placeButtonStyle}
                    title="向同地图在线玩家发送赠送请求"
                  >
                    {transferBusyId === selectedItem.entryId ? "发送中" : "赠送"}
                  </button>
                </div>
              )}
              {onlinePlayers.length > 0 && targetTradeItems.length > 0 && (
                <div style={tradeControlsStyle}>
                  <select
                    value={requestedEntryId}
                    onChange={(event) => setRequestedEntryId(event.target.value)}
                    style={tradeSelectStyle}
                    title="选择想交换的对方物品"
                    disabled={loadingTradeItems}
                  >
                    {targetTradeItems.map((item) => (
                      <option key={item.entryId} value={item.entryId}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void requestTrade(selectedItem)}
                    disabled={!targetUserId || !requestedEntryId || transferBusyId === `trade:${selectedItem.entryId}`}
                    style={placeButtonStyle}
                    title="向同地图在线玩家发起交换请求"
                  >
                    {transferBusyId === `trade:${selectedItem.entryId}` ? "发起中" : "交换"}
                  </button>
                </div>
              )}
              {onlinePlayers.length === 0 && (
                <div style={tradeHintStyle}>交易需要同地图有其他在线玩家。</div>
              )}
              {onlinePlayers.length > 0 && !loadingTradeItems && targetTradeItems.length === 0 && (
                <div style={tradeHintStyle}>对方当前没有可交换的背包物品。</div>
              )}
              <button
                onClick={() => void dropItem(selectedItem)}
                disabled={deletingEntryId === selectedItem.entryId}
                style={dropButtonStyle(deletingEntryId === selectedItem.entryId)}
                title="丢弃物品"
              >
                {deletingEntryId === selectedItem.entryId ? "处理中" : "丢弃"}
              </button>
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

function isUsableItem(item: InventoryItemInfo): boolean {
  return item.metadata?.usable === true;
}

function assetUrlForItem(item: InventoryItemInfo): string {
  const value = item.metadata?.assetUrl;
  return typeof value === "string" ? withAssetAuth(value) : "";
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function nameForEntry(items: InventoryItemInfo[], entryId: string): string {
  if (!entryId) return "";
  return items.find((item) => item.entryId === entryId)?.name ?? "";
}

function shortDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
  maxHeight: "min(620px, calc(100vh - 150px))",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(136px, 1fr))",
  gap: 10,
};

const generatorStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 8,
  padding: "12px 12px 0",
};

const costHintStyle = (canAfford: boolean): CSSProperties => ({
  gridColumn: "1 / -1",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minHeight: 24,
  padding: "0 2px",
  color: canAfford ? "rgba(238,244,255,0.76)" : "#ffb8b8",
  fontSize: 12,
});

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
    minHeight: 152,
    minWidth: 0,
    display: "grid",
    gridTemplateRows: "112px auto",
    gap: 7,
    padding: 9,
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
  height: 112,
  display: "grid",
  placeItems: "center",
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(0,0,0,0.18)",
  overflow: "visible",
  padding: 4,
};

const cellImageStyle: CSSProperties = {
  display: "block",
  width: "auto",
  height: "auto",
  maxWidth: "100%",
  maxHeight: 112,
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

const giftControlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "0 0 auto",
};

const giftSelectStyle: CSSProperties = {
  height: 28,
  maxWidth: 116,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(0,0,0,0.24)",
  color: "#eef4ff",
  padding: "0 7px",
  fontSize: 12,
};

const tradeControlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "1 1 100%",
  minWidth: 0,
};

const tradeSelectStyle: CSSProperties = {
  height: 28,
  minWidth: 120,
  maxWidth: 172,
  flex: "1 1 auto",
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(0,0,0,0.24)",
  color: "#eef4ff",
  padding: "0 7px",
  fontSize: 12,
};

const tradeHintStyle: CSSProperties = {
  flex: "1 1 100%",
  padding: "7px 9px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.045)",
  color: "rgba(238,244,255,0.62)",
  fontSize: 11,
  lineHeight: 1.4,
};

const transferPanelStyle: CSSProperties = {
  margin: 12,
  marginBottom: 0,
  padding: 10,
  border: "1px solid rgba(116,185,255,0.18)",
  background: "rgba(116,185,255,0.07)",
};

const transferTitleStyle: CSSProperties = {
  marginBottom: 8,
  fontSize: 12,
  fontWeight: 800,
  color: "#dff3ff",
};

const transferRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minHeight: 30,
};

const transferItemNameStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
};

const historyPanelStyle = (collapsed: boolean): CSSProperties => ({
  margin: 12,
  marginBottom: 0,
  padding: collapsed ? "8px 10px" : 10,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(0,0,0,0.14)",
});

const historyHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
  fontWeight: 800,
  color: "#dff3ff",
};

const historyHeaderActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const historySelectStyle: CSSProperties = {
  height: 26,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(0,0,0,0.24)",
  color: "#eef4ff",
  padding: "0 6px",
  fontSize: 12,
};

const historyToggleButtonStyle: CSSProperties = {
  height: 26,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "#dff3ff",
  padding: "0 8px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const historyRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: 28,
  fontSize: 12,
};

const historyTimeStyle: CSSProperties = {
  flex: "0 0 auto",
  color: "rgba(238,244,255,0.48)",
  fontSize: 11,
};

const historyEmptyStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(238,244,255,0.48)",
};

const miniActionButtonStyle = (danger: boolean): CSSProperties => ({
  height: 26,
  border: danger ? "1px solid rgba(255,120,120,0.34)" : "1px solid rgba(166,240,198,0.34)",
  background: danger ? "rgba(255,120,120,0.12)" : "rgba(68,189,120,0.14)",
  color: danger ? "#ffd0d0" : "#c9f8d9",
  padding: "0 8px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
});

function dropButtonStyle(busy: boolean): CSSProperties {
  return {
    height: 28,
    border: "1px solid rgba(255,202,87,0.36)",
    background: busy ? "rgba(255,202,87,0.08)" : "rgba(255,202,87,0.14)",
    color: "#ffe2a0",
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
  flexWrap: "wrap",
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
