# 多人账户、角色交互与物品系统扩展架构

## 目标

后续系统需要同时支持多人账户隔离、一个用户拥有多个可操作角色、用户角色和 NPC 交互、角色之间交互、可生成物品、背包、地图摆放、玩家之间交换物品。为了避免继续把所有东西塞进 `player_avatar.inventory` 或 `world_global_state`，新架构把“谁”“在哪里”“拥有什么”“和谁交互”拆成稳定领域对象。

## 核心概念

- `UserAccount`：真实用户账户或本地用户身份，是多人隔离的第一层边界。
- `UserCharacter`：用户拥有的可操作角色。一个用户可以有多个角色，但同一个角色同一时刻只能处在一个 `{ worldId, timelineId, mapId }`。
- `NpcCharacter`：世界生成出的 AI 角色，继续使用 `characters/` profile 和 `character_states`。
- `ActorRef`：统一引用“可交互行动者”，格式为 `{ actorType, actorId }`，其中 `actorType` 为 `user_character` 或 `npc`。
- `PresenceScope`：多人联机房间边界，包含 `{ worldId, timelineId, mapId }`。
- `ItemDefinition`：物品定义，例如名称、描述、图标、类别、堆叠上限、是否可摆放。
- `ItemInstance`：具体物品实例。稀有物、装备、带状态的道具必须是实例；普通材料也可以按 stack 记录。
- `InventoryEntry`：某个 owner 拥有的物品条目。owner 可以是用户角色、NPC、容器或系统。
- `MapItemPlacement`：物品被摆放在某个地图中的位置和朝向。
- `ItemTransfer`：两个 owner 之间的物品移动记录，支持赠送、交易、掉落、拾取和系统奖励。
- `ActorRelationship`：任意两个行动者之间的关系状态，用于后续玩家和 NPC、玩家和玩家、NPC 和 NPC 的互动。

## 数据边界

账户层数据和时间线运行态分开：

- 账户与用户角色基础资料属于账户层，可以跨时间线存在。
- 角色 presence、背包、地图摆放、交换记录属于时间线运行态，应写入当前 timeline DB。
- 世界生成出的物品定义可以来自 `world.json`、生成管线产物或 timeline DB；真正“这件物品现在在哪里”必须在 timeline DB。

这意味着同一个世界的不同时间线可以拥有不同的背包、物品摆放和交易历史。复制新时间线时，应复制用户角色 presence、背包、地图物品摆放和关系状态，生成新的运行分支。

## 数据表规划

当前阶段先建兼容表，后续 API 和 UI 再逐步接入。

| 表 | 作用 |
|---|---|
| item_definitions | 物品定义，记录名称、描述、类别、图标、堆叠规则、是否可摆放；类别包含家具、装饰、容器、工具等 |
| item_instances | 物品实例，记录 definition、世界/时间线归属、状态 JSON |
| inventory_entries | 背包条目，owner 可以是用户角色、NPC、容器或系统 |
| map_item_placements | 已摆放物品，绑定 world/timeline/map 和坐标 |
| item_transfers | 物品转移流水，用于交换、拾取、掉落、系统奖励审计 |
| actor_relationships | 行动者之间的关系状态 |
| actor_interactions | 行动者交互事件，作为后续互动系统的结构化入口 |

旧字段 `user_characters.inventory` 和 `player_avatar.inventory` 暂时保留，只作为兼容镜像。新物品系统上线后，背包主数据应迁到 `inventory_entries`，旧 JSON 字段只同步摘要或逐步停用。

资源和物品必须保持边界清晰：

- 资源是世界内的货币/能量账户，用于角色生成、地图生成、物品生成等付费。
- 采集资源只增加资源账户，不创建物品实例，也不进入背包。
- 物品由独立的 AI 物品生成、拾取、交易、系统奖励等流程产生。
- 玩家想要家具、小建筑、装饰物时，应消耗资源调用物品生成管线，生成可放置物品后进入背包。

## AI 生成物品

物品生成入口和资源采集分离。玩家输入一句提示词，例如“宋朝酒肆用的矮木桌”或“可以摆在院子里的小石灯”，服务端执行：

1. 校验当前账户拥有 `userCharacterId`。
2. 从资源账户扣除物品生成成本。
3. 使用结构化生成器产出物品定义：名称、描述、类别、是否可摆放、footprint、是否阻挡移动、交互提示和后续素材生成 prompt。
4. 生成物品素材，写入世界目录 `items/`，并在 metadata 中记录 `assetUrl`。
5. 写入 `item_definitions`、`item_instances`、`inventory_entries` 和 `item_transfers`。
6. 返回生成出的背包物品。

当前第一版 API 为 `POST /api/items/generate`：

```json
{
  "userCharacterId": "player_xxx",
  "prompt": "一张宋朝酒肆木桌"
}
```

物品生成不再使用本地规则或 SVG 兜底。服务端必须先通过结构化模型得到物品定义，再通过图像 API 生成透明 PNG 素材，并在保存前执行一次边缘背景移除和透明空边裁切，然后写入世界目录 `items/`。任一步失败都会让 `POST /api/items/generate` 返回错误，已扣除的资源会退回，前端显示“物品生成失败”的提示，不会创建文字牌、程序化素材或半成品背包物品。历史世界里已经存在的 SVG 物品仍可渲染，但新生成物品只写入 API 生成的 PNG。

背包以格子形式展示物品素材和名称；点击格子后显示摆放/删除操作。进入摆放模式时，地图预览会复用同一份 PNG 素材叠加在占用格上，未加载完成时先显示占用格，加载完成后自动显示真实图片。

## 所有权模型

物品所有权统一使用 owner：

```ts
type InventoryOwnerType =
  | "user_character"
  | "npc"
  | "container"
  | "system";

type InventoryOwnerRef = {
  ownerType: InventoryOwnerType;
  ownerId: string;
};
```

规则：

- 用户账户不直接持有地图内物品，账户通过 `user_character` 间接持有。
- 用户角色可以把物品放入地图，此时背包 entry 减少或移除，创建 `map_item_placements`。
- 地图上的物品被拾取时，placement 标为 `picked_up`，同时把原 `ItemInstance` 写回目标角色背包。
- 玩家之间交换物品时，必须在同一 `PresenceScope` 内，且双方 owner 都可用。
- NPC 也可以持有物品，但是否允许玩家交换由交互规则控制。

## 摆放与可行走 tile

摆放系统不直接相信前端坐标。服务端必须把摆放像素坐标转换成地图 tile，并按 collision grid 校验：

- 摆放请求使用像素坐标 `{ x, y }`，语义是物品脚点/中心点。
- 服务端用当前地图 tileSize 计算 `{ tileX, tileY }`。
- 默认 footprint 为 `1x1` tile。
- footprint 内每个 tile 都必须在地图内且可行走。
- 不可行走 tile、地图外 tile、未加载地图 runtime 都拒绝摆放。
- footprint 是碰撞/占地尺寸，不等于屏幕可见尺寸。前端渲染时会把道具贴图放大到可见的最小视觉尺寸，并以 footprint 中心对齐。

摆放物阻挡使用独立的 runtime `placement_collision`，不修改原始 TMJ collision 图层。服务端摆放时会拒绝和已有摆放物 footprint 重叠；前端加载/新增摆放物后，会把 `blocksMovement !== false` 的 footprint 写入 MapManager 的动态阻挡 tile，并刷新寻路网格。这样可以让物品被拾取/移动时动态恢复通行。

前端第一版摆放交互：

- 背包中可摆放物品显示“摆放”按钮。
- 点击后进入地图摆放模式，禁用角色点击移动。
- 鼠标在地图上显示 footprint 预览，绿色表示前端初步可摆放，红色表示不可摆放。
- 左键调用 `POST /api/items/place`，由服务端最终校验并落库。
- 右键或 Esc 取消摆放模式。
- 已摆放物品优先加载 `assetUrl` 对应 PNG/SVG 素材渲染；缺少素材时回退到程序绘制的占位块和名称标签。
- 会阻挡移动的摆放物会立即影响本地点击移动和寻路。
- 点击已摆放物品会打开操作菜单，当前支持“拾取”，拾取后刷新地图摆放层和背包。

## 多人联机隔离

多人隔离以 `PresenceScope` 为默认房间：

- 在线列表、移动、聊天、NPC 回复已经按 `{ worldId, timelineId, mapId }` 广播。
- 物品拾取、摆放、交换也必须按同一 scope 广播。
- 跨地图交易默认不允许，除非后续引入邮件、仓库或全局市场。
- 同一账户可以拥有多个角色，但一个角色只能有一个在线 presence；同一角色多端登录应使用接管/复用策略，而不是复制一个角色实体。

后续 WebSocket 事件建议新增：

- `item_spawned`
- `item_picked_up`
- `item_placed`
- `item_removed`
- `item_transfer_requested`
- `item_transfer_completed`
- `actor_interaction_started`
- `actor_interaction_updated`

旧 `player_*` 事件继续兼容一段时间，新事件使用 `user_character_*`、`item_*`、`actor_*` 命名。

## 交互系统

角色与角色、角色与 NPC 的交互统一走 `ActorInteraction`：

```ts
type ActorInteractionKind =
  | "chat"
  | "trade"
  | "gift"
  | "inspect"
  | "assist"
  | "conflict";
```

交互发起者和目标都使用 `ActorRef`。这样后续可以自然支持：

- 玩家角色和 NPC 对话。
- 玩家角色给 NPC 赠送物品。
- 两个玩家交换物品。
- NPC 和 NPC 之间的剧情互动。
- 玩家角色触发协作任务。

## 迁移顺序

1. 保留现有资源数和采集按钮，新增物品领域类型与 DB 表。
2. 把采集产物从“全局资源数”扩展为“可选生成物品 entry”，旧资源数继续同步用于建造成本。
3. 增加背包 API：查询角色背包、移动物品、丢弃物品。
4. 增加地图摆放 API：摆放、拾取、查询当前地图物品。
5. 增加交换 API：发起交换、确认、取消、完成事务。
6. 把多人 WebSocket 的物品事件按 `PresenceScope` 广播。
7. 再做 UI：背包面板、地图物品渲染、交换弹窗、摆放模式。

## 当前实现边界

本阶段只做架构扩展空间：

- 新增领域类型。
- 新增 timeline DB 表。
- 文档明确账户、角色、物品、地图、时间线和联机隔离边界。

不会立刻替换当前采集和资源 UI，避免影响现有可玩链路。
