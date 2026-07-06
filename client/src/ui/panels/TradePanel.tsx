import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type Phaser from "phaser";
import { networkManager } from "../../systems/NetworkManager";
import { withAssetAuth } from "../../utils/asset-url";
import {
  apiClient,
  type InventoryItemInfo,
  type ItemTransferInfo,
  type OnlinePlayerInfo,
} from "../services/api-client";
import { centeredWindowStyle, useFloatingWindowZIndex } from "../components/panel-styles";

type TransferStatusFilter = "completed" | "cancelled" | "failed";

export function TradePanel({
  open,
  onClose,
  eventBus,
}: {
  open: boolean;
  onClose: () => void;
  eventBus: Phaser.Events.EventEmitter;
}) {
  const [items, setItems] = useState<InventoryItemInfo[]>([]);
  const [onlinePlayers, setOnlinePlayers] = useState<OnlinePlayerInfo[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
  const [targetItems, setTargetItems] = useState<InventoryItemInfo[]>([]);
  const [offerEntryId, setOfferEntryId] = useState("");
  const [requestedEntryId, setRequestedEntryId] = useState("");
  const [incomingTransfers, setIncomingTransfers] = useState<ItemTransferInfo[]>([]);
  const [outgoingTransfers, setOutgoingTransfers] = useState<ItemTransferInfo[]>([]);
  const [historyTransfers, setHistoryTransfers] = useState<ItemTransferInfo[]>([]);
  const [historyStatus, setHistoryStatus] = useState<TransferStatusFilter>("completed");
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingTargetItems, setLoadingTargetItems] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const userCharacterId = useMemo(() => networkManager.getSelectedUserCharacterId() || networkManager.getPlayerId() || "", [open]);
  const { zIndex, bringToFront } = useFloatingWindowZIndex(open, 840);

  const selectedOffer = items.find((item) => item.entryId === offerEntryId) ?? null;
  const selectedTargetItem = targetItems.find((item) => item.entryId === requestedEntryId) ?? null;
  const targetPlayer = onlinePlayers.find((player) => player.userId === targetUserId) ?? null;

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError("");
    try {
      const [inventory, requested, online, history] = await Promise.all([
        apiClient.getAccountInventory(),
        apiClient.getItemTransfers("requested"),
        apiClient.getOnlinePlayers(userCharacterId || undefined).catch(() => null),
        apiClient.getItemTransfers(historyStatus),
      ]);
      const nextItems = inventory.items;
      const players = (online?.players ?? []).filter((player) => !player.isSelf && player.isCurrentMap);
      setItems(nextItems);
      setIncomingTransfers(requested.incoming);
      setOutgoingTransfers(requested.outgoing);
      setHistoryTransfers([...history.incoming, ...history.outgoing].slice(0, 16));
      setOnlinePlayers(players);
      setOfferEntryId((current) => nextItems.some((item) => item.entryId === current) ? current : nextItems[0]?.entryId ?? "");
      setTargetUserId((current) => players.some((player) => player.userId === current) ? current : players[0]?.userId ?? "");
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
    if (!open) return undefined;
    const onChanged = () => void refresh();
    eventBus.on("inventory_changed", onChanged);
    eventBus.on("item_transfer_requested", onChanged);
    eventBus.on("item_transfer_completed", onChanged);
    eventBus.on("item_transfer_cancelled", onChanged);
    return () => {
      eventBus.off("inventory_changed", onChanged);
      eventBus.off("item_transfer_requested", onChanged);
      eventBus.off("item_transfer_completed", onChanged);
      eventBus.off("item_transfer_cancelled", onChanged);
    };
  }, [eventBus, open, refresh]);

  useEffect(() => {
    if (!open || !userCharacterId || !targetUserId) {
      setTargetItems([]);
      setRequestedEntryId("");
      return;
    }
    let cancelled = false;
    setLoadingTargetItems(true);
    apiClient.getTradeCandidates({ userCharacterId, targetUserId })
      .then((response) => {
        if (cancelled) return;
        setTargetItems(response.items);
        setRequestedEntryId((current) => response.items.some((item) => item.entryId === current)
          ? current
          : response.items[0]?.entryId ?? "");
      })
      .catch(() => {
        if (cancelled) return;
        setTargetItems([]);
        setRequestedEntryId("");
      })
      .finally(() => {
        if (!cancelled) setLoadingTargetItems(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetUserId, userCharacterId]);

  if (!open) return null;

  const requestGift = async () => {
    if (!selectedOffer || !targetUserId || busyId) return;
    setBusyId(`gift:${selectedOffer.entryId}`);
    setError("");
    setNotice("");
    try {
      await apiClient.requestItemTransfer({
        userCharacterId,
        entryId: selectedOffer.entryId,
        targetUserId,
      });
      setNotice(`已向 ${targetPlayer?.playerName || "对方"} 发送赠送请求。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  const requestTrade = async () => {
    if (!selectedOffer || !requestedEntryId || !targetUserId || busyId) return;
    setBusyId(`trade:${selectedOffer.entryId}`);
    setError("");
    setNotice("");
    try {
      await apiClient.requestItemTrade({
        userCharacterId,
        offerEntryId: selectedOffer.entryId,
        requestedEntryId,
        targetUserId,
      });
      setNotice(`已发起交换：${selectedOffer.name} ⇄ ${selectedTargetItem?.name || "对方物品"}。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  const respondTransfer = async (transfer: ItemTransferInfo, accept: boolean) => {
    if (busyId) return;
    setBusyId(transfer.id);
    setError("");
    setNotice("");
    try {
      await apiClient.respondItemTransfer(transfer.id, accept);
      setNotice(accept ? "请求已接受。" : "请求已拒绝。");
      eventBus.emit("inventory_changed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  const cancelTransfer = async (transfer: ItemTransferInfo) => {
    if (busyId) return;
    setBusyId(transfer.id);
    setError("");
    setNotice("");
    try {
      await apiClient.cancelItemTransfer(transfer.id);
      setNotice("请求已撤销。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  };

  return (
    <aside style={{ ...panelStyle, zIndex }} onPointerDown={bringToFront}>
      <header style={headerStyle}>
        <div>
          <div style={titleStyle}>交易</div>
          <div style={subtitleStyle}>与同地图在线玩家赠送或交换账号背包物品。</div>
        </div>
        <button onClick={onClose} style={closeButtonStyle} title="关闭交易">×</button>
      </header>

      {error && <div style={errorStyle}>{error}</div>}
      {notice && <div style={noticeStyle}>{notice}</div>}

      <div className="custom-scrollbar" style={bodyStyle}>
        <section style={requestGridStyle}>
          <Panel title="同地图玩家" hint={onlinePlayers.length === 0 ? "当前没有其他同地图在线玩家。" : ""}>
            <div style={listStyle}>
              {onlinePlayers.map((player) => (
                <button
                  key={`${player.userId}:${player.playerId}`}
                  type="button"
                  onClick={() => setTargetUserId(player.userId)}
                  style={selectableRowStyle(targetUserId === player.userId)}
                >
                  <span style={avatarStyle}>{(player.playerName || player.userId).slice(0, 1)}</span>
                  <span style={rowTextStyle}>{player.playerName || player.userId}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="我的物品" hint={items.length === 0 ? "你的背包暂无可交易物品。" : ""}>
            <div style={itemGridStyle}>
              {items.map((item) => (
                <button
                  key={item.entryId}
                  type="button"
                  onClick={() => setOfferEntryId(item.entryId)}
                  style={itemCellStyle(offerEntryId === item.entryId)}
                  title={item.description || item.name}
                >
                  <ItemPreview item={item} />
                  <span style={itemNameStyle}>{item.name}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel
            title="对方物品"
            hint={
              !targetUserId
                ? "先选择一个玩家。"
                : loadingTargetItems
                  ? "加载对方物品中..."
                  : targetItems.length === 0
                    ? "对方当前没有可交换物品。"
                    : ""
            }
          >
            <div style={itemGridStyle}>
              {targetItems.map((item) => (
                <button
                  key={item.entryId}
                  type="button"
                  onClick={() => setRequestedEntryId(item.entryId)}
                  style={itemCellStyle(requestedEntryId === item.entryId)}
                  title={item.description || item.name}
                >
                  <ItemPreview item={item} />
                  <span style={itemNameStyle}>{item.name}</span>
                </button>
              ))}
            </div>
          </Panel>
        </section>

        <section style={actionBarStyle}>
          <div style={tradeSummaryStyle}>
            {selectedOffer ? `出：${selectedOffer.name}` : "请选择你的物品"}
            {selectedTargetItem ? `  换：${selectedTargetItem.name}` : ""}
          </div>
          <button
            onClick={() => void requestGift()}
            disabled={!selectedOffer || !targetUserId || Boolean(busyId)}
            style={primaryButtonStyle(!selectedOffer || !targetUserId || Boolean(busyId))}
          >
            {busyId.startsWith("gift:") ? "发送中" : "赠送"}
          </button>
          <button
            onClick={() => void requestTrade()}
            disabled={!selectedOffer || !targetUserId || !requestedEntryId || Boolean(busyId)}
            style={primaryButtonStyle(!selectedOffer || !targetUserId || !requestedEntryId || Boolean(busyId))}
          >
            {busyId.startsWith("trade:") ? "发起中" : "交换"}
          </button>
        </section>

        {(incomingTransfers.length > 0 || outgoingTransfers.length > 0) && (
          <section style={transferColumnsStyle}>
            <TransferList
              title="收到的请求"
              transfers={incomingTransfers}
              busyId={busyId}
              onAccept={(transfer) => void respondTransfer(transfer, true)}
              onReject={(transfer) => void respondTransfer(transfer, false)}
            />
            <TransferList
              title="发出的请求"
              transfers={outgoingTransfers}
              busyId={busyId}
              onCancel={(transfer) => void cancelTransfer(transfer)}
            />
          </section>
        )}

        <section style={historyPanelStyle}>
          <div style={historyHeaderStyle}>
            <span>交易历史</span>
            <div style={{ display: "flex", gap: 8 }}>
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
              <button type="button" onClick={() => setHistoryCollapsed((value) => !value)} style={smallButtonStyle(false)}>
                {historyCollapsed ? "展开" : "收起"}
              </button>
            </div>
          </div>
          {!historyCollapsed && (
            historyTransfers.length === 0 ? (
              <div style={emptyTextStyle}>暂无记录</div>
            ) : (
              <div style={listStyle}>
                {historyTransfers.map((transfer) => (
                  <div key={transfer.id} style={transferRowStyle}>
                    <span>{transferLabel(transfer)}</span>
                    <span style={mutedTextStyle}>{shortDate(transfer.createdAt)}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </section>
      </div>

      {loading && <div style={loadingStyle}>刷新中...</div>}
    </aside>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      {hint && <div style={emptyTextStyle}>{hint}</div>}
      {children}
    </section>
  );
}

function ItemPreview({ item }: { item: InventoryItemInfo }) {
  const url = assetUrlForItem(item);
  return (
    <span style={previewStyle}>
      {url ? <img src={url} alt={item.name} style={previewImageStyle} draggable={false} /> : "◇"}
    </span>
  );
}

function TransferList({
  title,
  transfers,
  busyId,
  onAccept,
  onReject,
  onCancel,
}: {
  title: string;
  transfers: ItemTransferInfo[];
  busyId: string;
  onAccept?: (transfer: ItemTransferInfo) => void;
  onReject?: (transfer: ItemTransferInfo) => void;
  onCancel?: (transfer: ItemTransferInfo) => void;
}) {
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      {transfers.length === 0 ? (
        <div style={emptyTextStyle}>暂无请求</div>
      ) : (
        <div style={listStyle}>
          {transfers.map((transfer) => (
            <div key={transfer.id} style={transferRowStyle}>
              <span style={transferTextStyle}>{transferLabel(transfer)}</span>
              <span style={{ display: "flex", gap: 6 }}>
                {onAccept && <button onClick={() => onAccept(transfer)} disabled={busyId === transfer.id} style={smallButtonStyle(false)}>{transfer.kind === "trade" ? "交换" : "接收"}</button>}
                {onReject && <button onClick={() => onReject(transfer)} disabled={busyId === transfer.id} style={smallButtonStyle(true)}>拒绝</button>}
                {onCancel && <button onClick={() => onCancel(transfer)} disabled={busyId === transfer.id} style={smallButtonStyle(true)}>撤销</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function assetUrlForItem(item: InventoryItemInfo): string {
  const value = item.metadata?.assetUrl;
  return typeof value === "string" ? withAssetAuth(value) : "";
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function transferLabel(transfer: ItemTransferInfo): string {
  if (transfer.kind === "trade") {
    return `交换：${stringMetadata(transfer.metadata, "offeredItemName") || transfer.item?.name || "未知物品"} ⇄ ${stringMetadata(transfer.metadata, "requestedItemName") || "对方物品"}`;
  }
  return `赠送：${transfer.item?.name || "未知物品"}`;
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const panelStyle: CSSProperties = {
  ...centeredWindowStyle(860, 840),
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const titleStyle: CSSProperties = { fontSize: 18, fontWeight: 900 };
const subtitleStyle: CSSProperties = { marginTop: 4, fontSize: 12, color: "rgba(238,244,255,0.62)" };

const closeButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.07)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 20,
};

const bodyStyle: CSSProperties = {
  maxHeight: "min(620px, calc(100vh - 132px))",
  overflowY: "auto",
  padding: 14,
  display: "grid",
  gap: 12,
};

const requestGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(150px, 0.75fr) minmax(190px, 1fr) minmax(190px, 1fr)",
  gap: 10,
};

const sectionStyle: CSSProperties = {
  minWidth: 0,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.045)",
};

const sectionTitleStyle: CSSProperties = {
  marginBottom: 8,
  fontSize: 12,
  fontWeight: 900,
  color: "#dff3ff",
};

const listStyle: CSSProperties = { display: "grid", gap: 7 };

function selectableRowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    minWidth: 0,
    padding: 8,
    borderRadius: 10,
    border: active ? "1px solid rgba(116,185,255,0.48)" : "1px solid rgba(255,255,255,0.09)",
    background: active ? "rgba(116,185,255,0.14)" : "rgba(255,255,255,0.045)",
    color: "#eef4ff",
    cursor: "pointer",
    textAlign: "left",
  };
}

const avatarStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  display: "grid",
  placeItems: "center",
  background: "rgba(116,185,255,0.14)",
  border: "1px solid rgba(116,185,255,0.24)",
  flexShrink: 0,
};

const rowTextStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 13,
  fontWeight: 800,
};

const itemGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))",
  gap: 8,
};

function itemCellStyle(active: boolean): CSSProperties {
  return {
    minHeight: 100,
    display: "grid",
    gridTemplateRows: "58px auto",
    gap: 6,
    alignItems: "center",
    justifyItems: "center",
    padding: 8,
    borderRadius: 10,
    border: active ? "1px solid rgba(116,185,255,0.52)" : "1px solid rgba(255,255,255,0.1)",
    background: active ? "rgba(116,185,255,0.14)" : "rgba(255,255,255,0.045)",
    color: "#eef4ff",
    cursor: "pointer",
  };
}

const previewStyle: CSSProperties = {
  width: 58,
  height: 58,
  display: "grid",
  placeItems: "center",
  borderRadius: 10,
  background: "rgba(0,0,0,0.22)",
  overflow: "hidden",
};

const previewImageStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

const itemNameStyle: CSSProperties = {
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  fontWeight: 800,
};

const actionBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.045)",
};

const tradeSummaryStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "rgba(238,244,255,0.72)",
  fontSize: 12,
};

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    border: "1px solid rgba(116,185,255,0.42)",
    background: disabled ? "rgba(116,185,255,0.08)" : "rgba(116,185,255,0.18)",
    color: "#dff3ff",
    borderRadius: 999,
    padding: "8px 14px",
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

const transferColumnsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

const transferRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: 8,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
};

const transferTextStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
};

function smallButtonStyle(danger: boolean): CSSProperties {
  return {
    border: danger ? "1px solid rgba(255,118,117,0.34)" : "1px solid rgba(116,185,255,0.34)",
    background: danger ? "rgba(255,118,117,0.1)" : "rgba(116,185,255,0.12)",
    color: danger ? "#ffd0d0" : "#dff3ff",
    borderRadius: 999,
    padding: "5px 9px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  };
}

const historyPanelStyle: CSSProperties = {
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.035)",
};

const historyHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  fontSize: 12,
  fontWeight: 900,
};

const historySelectStyle: CSSProperties = {
  height: 28,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(0,0,0,0.22)",
  color: "#eef4ff",
  borderRadius: 8,
};

const emptyTextStyle: CSSProperties = {
  padding: 10,
  color: "rgba(238,244,255,0.56)",
  fontSize: 12,
  lineHeight: 1.45,
};

const mutedTextStyle: CSSProperties = {
  color: "rgba(238,244,255,0.48)",
  fontSize: 11,
  flexShrink: 0,
};

const errorStyle: CSSProperties = {
  margin: "12px 14px 0",
  padding: 10,
  borderRadius: 10,
  border: "1px solid rgba(255,118,117,0.24)",
  background: "rgba(255,118,117,0.1)",
  color: "#ffb8b8",
  fontSize: 12,
};

const noticeStyle: CSSProperties = {
  margin: "12px 14px 0",
  padding: 10,
  borderRadius: 10,
  border: "1px solid rgba(85,239,196,0.22)",
  background: "rgba(85,239,196,0.1)",
  color: "#bdf8df",
  fontSize: 12,
};

const loadingStyle: CSSProperties = {
  position: "absolute",
  right: 14,
  bottom: 12,
  color: "rgba(238,244,255,0.5)",
  fontSize: 11,
};
