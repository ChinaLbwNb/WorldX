import "./i18n";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { EventBus } from "./EventBus";
import { networkManager } from "./systems/NetworkManager";

if (import.meta.env.DEV) {
  (window as typeof window & { __WORLDX_EVENT_BUS__?: typeof EventBus.instance }).__WORLDX_EVENT_BUS__ = EventBus.instance;
  window.addEventListener("__WORLDX_TEST_EVENT__", (event) => {
    const detail = (event as CustomEvent<{ type?: string; payload?: unknown }>).detail;
    if (!detail?.type) return;
    const payload = detail.payload as any;
    if (payload?.target?.userId === "__CURRENT_USER__") payload.target.userId = networkManager.getUserId();
    if (payload?.transfer?.toOwner?.ownerId === "__CURRENT_USER__") payload.transfer.toOwner.ownerId = networkManager.getUserId();
    EventBus.instance.emit(detail.type, payload);
  });
  if (new URLSearchParams(window.location.search).get("devTransferModal") === "1") {
    window.setTimeout(() => {
      const userId = networkManager.getUserId();
      EventBus.instance.emit("item_transfer_requested", {
        scope: { worldId: "dev_world", timelineId: "dev_timeline", mapId: "map_origin" },
        actor: { userId: "dev_other_user", userCharacterId: "dev_other_character" },
        target: { userId },
        transfer: {
          id: `dev_transfer_modal_${Date.now()}`,
          userId: "dev_other_user",
          worldId: "dev_world",
          timelineId: "dev_timeline",
          mapId: "map_origin",
          itemInstanceId: "dev_item_modal",
          quantity: 1,
          fromOwner: { ownerType: "account", ownerId: "dev_other_user" },
          toOwner: { ownerType: "account", ownerId: userId },
          kind: "trade",
          status: "requested",
          metadata: { fromCharacterName: "测试玩家", requestedEntryId: "你的测试物品" },
          createdAt: new Date().toISOString(),
          item: {
            entryId: "dev_entry_modal",
            itemInstanceId: "dev_item_modal",
            definitionId: "dev_definition_modal",
            name: "蓝色贝壳灯",
            description: "测试交易弹窗物品",
            category: "decoration",
            iconKey: null,
            quantity: 1,
            stackable: true,
            maxStack: 1,
            placeable: true,
            state: {},
            metadata: {},
          },
        },
      });
    }, 1800);
  }
}

const uiRoot = document.getElementById("ui-root")!;
createRoot(uiRoot).render(<App eventBus={EventBus.instance} />);
