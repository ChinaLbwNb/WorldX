# 用户角色与 NPC 分离架构

## 目标

用户不是 NPC，也不是临时地图化身。用户拥有一个账户，可以创建多个可操作角色；每次进入世界时选择其中一个角色进入某个世界、某条时间线、某张地图。进入地图后，默认操控这个用户角色。

NPC 继续作为世界模拟对象存在，由 AI 决策、记忆、需求和时间线驱动。用户角色和 NPC 可以交互，但两者的数据归属、运行逻辑和持久化边界必须分开。

这套架构要为后续系统预留空间：

- 多用户联机，每个用户账户隔离。
- 一个用户创建多个角色。
- 一个用户角色只能唯一出现在一个 `{ worldId, timelineId, mapId }`。
- 用户角色和 NPC、用户角色和用户角色之间可交互。
- 用户角色有背包，物品可生成、交换、拾取、摆放。
- 地图是世界内的独立节点，用户角色可选择进入任意已解锁地图。

物品、交换和地图摆放的详细扩展见 [多人账户、角色交互与物品系统扩展架构](./multiplayer-items-architecture.md)。

## 概念边界

### UserAccount

真实用户账户，是多人隔离的第一层边界。当前已新增基础账号系统：用户通过用户名和密码注册/登录，服务端签发 session token，HTTP 使用 `Authorization: Bearer <token>`，WebSocket 使用握手参数 `token` 绑定账户。未登录时仍保留 `local_user` 作为历史兼容和本地调试身份。

当前产品规则是强制登录：未登录用户只能访问前端应用壳、登录注册页、`/api/auth/*` 和 `/api/health`，不能访问世界列表、角色、物品、生成、时间线、资源采集或 WebSocket 联机。`local_user/x-user-id/uid` 只作为迁移和开发兼容路径，不再允许绕过登录进入游戏主流程。

账户不直接在地图上行动，也不直接持有地图内物品。账户拥有多个 `UserCharacter`，实际进入地图、移动、采集、交互和持有背包的是用户角色。

账号创建时，系统会在当前已加载世界中创建两个固定的初始用户角色：

- `默认男角色`
- `默认女角色`

这两个默认角色不走 AI 生图管线，避免注册时产生等待和资源消耗。它们创建后就是该账号名下的普通固定角色资产，可以进入地图、切换、改名或在满足保护规则时删除。登录、`GET /api/user-characters` 和进入地图页不会再临时补角色；如果旧账号缺少角色，应走显式迁移或管理工具补齐，而不是由查询接口隐式写入。

### UserCharacter

用户拥有的可操作角色，包含：

- 基础资料：名字、外观、归属用户。
- 运行态：所在世界、时间线、地图、坐标、在线状态、当前动作。
- 背包：当前阶段仍有兼容字段 `inventory`，后续主数据应迁移到 `inventory_entries`。

一个用户可以拥有多个角色，但每个用户角色在任意时刻只能有一条当前运行态。

### NpcCharacter

世界内 AI 角色，继续使用：

- `config/characters/<charId>.json`
- `characters/<charId>/spritesheet.png`
- `character_states`
- `memories`
- `diary_entries`

NPC 参与 simulation tick，由 LLM/规则驱动行动、对话、记忆和情绪。NPC 不属于某个用户账户，不使用 `user_characters`。

### ActorRef

用户角色和 NPC 都是可交互行动者。后续交互系统不应该写死 `playerId` 或 `characterId`，而应统一使用：

```ts
type ActorRef = {
  actorType: "user_character" | "npc";
  actorId: string;
};
```

这样同一套交互系统可以支持：

- 用户角色和 NPC 对话。
- 用户角色和 NPC 交易或赠送物品。
- 两个用户角色交换物品。
- NPC 和 NPC 之间产生剧情互动。

### World / Map / Timeline

- `World`：一次初始生成得到的完整世界容器，目录为 `output/worlds/<worldId>` 或 `library/worlds/<worldId>`。
- `Map`：世界内的独立地图节点，目录为 `maps/<mapId>/`。
- `Timeline`：世界状态分支，每条时间线有自己的 `state.db` 和事件流。

用户角色的当前位置由 `{ worldId, timelineId, mapId, x, y }` 决定。不同时间线下，同一个角色可以拥有不同状态；创建新时间线时，应复制当前时间线中的用户角色运行态，形成分支。

### PresenceScope

多人联机的默认房间边界：

```ts
type PresenceScope = {
  worldId: string;
  timelineId: string;
  mapId: string;
};
```

在线列表、移动、聊天、NPC 回复、物品拾取、物品摆放、交换请求都应限制在同一个 `PresenceScope` 内广播和处理。

## 数据模型

当前实现已经从旧 `player_avatar` 主存储迁到独立用户角色表：

- `users`
- `user_characters`
- `user_character_runtime`

`player_avatar` 仍保留为旧接口、旧 WebSocket 字段和采集链路的兼容镜像，不再是新架构的主数据源。服务启动时会把旧 `player_avatar` 数据迁入 `user_characters`，之后用户角色状态更新会同步写入新表和旧表。

### users

账户表。当前支持本地多用户账户，默认存在：

```txt
id = local_user
display_name = 本地用户
```

当前 HTTP 和 WebSocket 账户上下文：

- 全局账号库位于 `output/auth.db`，不属于某个世界或时间线。
- HTTP 请求优先使用 `Authorization: Bearer <token>` 解析真实用户。
- WebSocket 握手优先使用 `token` query 参数解析真实用户。
- `/api/auth/*` 之外的游戏 API 需要有效 session token；无 token 返回 401。
- WebSocket 没有有效 token 时返回 `join_rejected: auth_required` 并关闭连接。
- `x-user-id` 和 `uid` 仍保留为迁移兼容字段，但不能绕过全局登录门。
- 客户端把 `worldx_auth_token` 和 `worldx_user_id` 写入 localStorage；退出登录会清空 token、当前角色选择和旧玩家 ID。
- 前端 `用户/账号` 面板提供注册、登录和退出；未登录时显示全屏登录门，不渲染游戏主 UI、不主动请求世界数据、不连接 WebSocket。登录后只能看到该账号下的角色、物品和可访问世界。

后续正式认证系统接入时：

- `auth_users.id` 应来自认证系统或被迁移为认证系统 subject。
- 用户只能看到、创建和进入自己账户下的 `user_characters`。
- 管理员或观察者工具可以通过单独权限查看其他用户角色。

### World Ownership

世界不再默认是全员共享容器。每个生成世界目录会写入 `worldx.meta.json`：

```json
{
  "ownerUserId": "user_xxx",
  "visibility": "private",
  "createdAt": "...",
  "updatedAt": "..."
}
```

当前规则：

- 新生成世界归属创建它的登录用户；未登录兼容模式归属 `local_user`。
- 旧世界没有 `worldx.meta.json` 时，默认视为 `local_user/private`，示例库世界视为 `system/public`。
- `/api/world/worlds` 只返回当前账号拥有或可访问的世界，以及示例库世界。
- `/api/world/select` 会校验当前账号是否可访问目标世界。
- `PATCH /api/world/worlds/:worldId` 允许世界 owner 修改 `visibility` 为 `private/unlisted/public`。
- `/api/world/worlds/:worldId` 删除时要求当前账号是世界 owner。

后续联机不应理解为“所有人自动在同一个世界”。正确模型是：

- 用户默认在自己的世界中创建角色、生成物品、生成地图。
- 访问他人世界需要对方世界开放、分享链接、邀请码或成员授权。
- 进入他人世界后，用户仍使用自己的账号身份，但角色运行态会绑定到目标世界、时间线和地图。

### user_characters

用户角色基础资料：

```txt
id
user_id
name
appearance
inventory
created_at
updated_at
```

说明：

- `appearance` 当前是 JSON，后续可拆出 sprite、颜色、装备显示等字段。
- `inventory` 是兼容字段，后续不再作为背包主数据。
- 一个 `user_id` 可以对应多个角色。

### user_character_runtime

用户角色运行态：

```txt
character_id
world_id
timeline_id
current_map_id
location
main_area_point_id
x
y
current_action
current_action_target
action_start_tick
action_end_tick
is_online
is_controlled_by_llm
updated_at
```

核心约束：

- `character_id` 是主键，因此一个用户角色同一时间线 DB 内只有一条运行态。
- `world_id + timeline_id + current_map_id` 决定联机隔离房间。
- `is_online` 表示当前是否有连接控制该角色。
- `is_controlled_by_llm` 只用于旧接管兼容，不代表 NPC。

### 未来背包主表

后续背包主数据应迁移到：

- `item_definitions`
- `item_instances`
- `inventory_entries`
- `map_item_placements`
- `item_transfers`

用户角色只通过 `ownerType = "user_character"` 和 `ownerId = userCharacterId` 持有物品。账户不直接持有地图内物品。

## 当前 API

已实现：

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/users`
- `GET /api/users/me`
- `POST /api/users`
- `PATCH /api/users/:id`
- `DELETE /api/users/:id`
- `GET /api/user-characters`
- `POST /api/user-characters`
- `PATCH /api/user-characters/:id`
- `DELETE /api/user-characters/:id`
- `GET /api/user-characters/:id/inventory`
- `POST /api/world/map/enter`

兼容 API 暂时保留：

- `POST /api/user-characters/:id/enter-map`

### Auth API

`POST /api/auth/register` 创建真实账号并返回 session token。

```ts
{
  username: string;
  password: string;
  displayName?: string;
}
```

`POST /api/auth/login` 使用用户名和密码登录并返回 session token。

`GET /api/auth/me` 根据 `Authorization: Bearer <token>` 返回当前账号。

`POST /api/auth/logout` 注销当前 token。

### GET /api/users

返回当前时间线 DB 内已知的用户投影列表，主要用于兼容和本地调试；真实账号主数据在 `output/auth.db`。每个用户包含：

```ts
{
  id: string;
  displayName: string;
  characterCount: number;
  createdAt: string;
  updatedAt: string;
}
```

### GET /api/users/me

根据 session token 或兼容 `x-user-id` 返回当前用户账户。若当前世界 DB 内没有该用户投影，会创建一个同 ID 的占位。

### POST /api/users

请求体：

```ts
{
  displayName: string;
  userId?: string;
}
```

创建一个当前世界 DB 内的用户投影。真实账号创建应使用 `/api/auth/register`；该接口主要保留给兼容工具和本地调试。

### PATCH /api/users/:id

修改本地用户显示名称。当前只允许改 `displayName`。

### DELETE /api/users/:id

删除本地用户账户。保护规则：

- `local_user` 不能删除。
- 该用户仍有用户角色时不能删除。
- 删除真实账户时，未来应改为认证系统内的禁用/注销流程，而不是直接从时间线 DB 移除。

### GET /api/user-characters

返回当前账号可用角色。若请求带有效 session token，服务端按真实账号过滤；否则按兼容 `x-user-id/local_user` 过滤。

返回对象应包含：

```ts
{
  id: string;
  name: string;
  worldId: string;
  timelineId: string;
  currentMapId: string;
  x: number;
  y: number;
  appearance: object;
  inventory: Array<{ itemId: string; name: string; quantity: number }>;
  online: boolean;
}
```

### POST /api/user-characters

创建当前用户账户下的新用户角色。当前会同步创建 `user_character_runtime`，把角色放入当前世界、当前时间线、当前 active map。

通过 `UserCharactersPanel` 创建时默认会调用用户角色素材生成管线；通过 API 也可传 `generateAppearance: false` 只创建角色实体。

后续应扩展：

- 角色外观选择。
- 初始背包模板。
- 每个用户的角色数量上限。
- 同名角色提示或允许重名但显示唯一短 ID。

### PATCH /api/user-characters/:id

修改当前用户拥有的角色资料。当前只允许改 `name`，后续可扩展到外观重生成、头像、装备显示等字段。

### DELETE /api/user-characters/:id

删除当前用户拥有的角色。保护规则：

- 角色不存在或不属于当前用户时返回 404。
- 角色在线时不能删除。
- 角色背包不为空时不能删除。
- 角色仍有已摆放在地图上的物品时不能删除。
- 删除成功会清理 `user_characters/user_character_runtime/player_avatar` 兼容镜像，并删除 `user-characters/<userCharacterId>/` 下的素材目录。

### POST /api/world/map/enter

请求体：

```ts
{
  userCharacterId: string;
  mapId: string;
}
```

当前流程：

1. 校验当前世界已加载。
2. 校验 `mapId` 存在。
3. 校验 `userCharacterId` 存在。
4. 校验该用户角色属于当前请求用户。
5. 切换当前 active map。
6. 刷新该地图资源节点。
7. 将用户角色放到目标地图合法出生点。
8. 写入 `user_character_runtime.world_id/timeline_id/current_map_id/x/y`。
9. 同步旧 `player_avatar` 镜像。
10. 返回 `presence` 和 `requiresReload: true`。

后续多人房间化后，第 4 步不应再切换全局 active map，而应进入该用户连接所属的 map room。

## WebSocket 与多人联机

当前 WebSocket 连接会绑定所选用户角色的 presence。

已按 `PresenceScope` 隔离的事件：

- `players_online`
- `player_joined`
- `player_left`
- `player_moved`
- `player_mode_changed`
- `player_chat`
- `npc_typing`
- `npc_chat`
- `npc_chat_error`

服务端已新增 `MapRuntimeRegistry` 作为房间运行态索引。它按 `PresenceScope` 记录当前 scope、在线用户角色 ID、地图资源节点缓存是否就绪和最近活跃时间。`GET /api/world/maps` 和 `GET /api/build/state` 会返回 `mapRuntimes`，供后续地图 UI、背包、物品摆放和多人房间调试使用。

命名仍保留旧 `player_*`，但语义已经是用户角色。后续建议新增并逐步迁移到：

- `user_character_joined`
- `user_character_left`
- `user_character_moved`
- `user_character_action_started`
- `actor_interaction_started`
- `actor_interaction_updated`
- `item_picked_up`
- `item_placed`
- `item_transfer_requested`
- `item_transfer_completed`

广播规则：

- 同一 `worldId`。
- 同一 `timelineId`。
- 同一 `mapId`。
- 只有同 scope 的客户端能收到彼此移动、聊天、物品和交互事件。

同一角色多端登录策略：

- 默认复用同一个 `userCharacterId`。
- 后连接可以接管旧连接，或允许多端共享视角但只有一个控制端。
- 不能创建第二个同 ID 的运行态。

## 前端运行时

当前前端入口：

- `UserAccountPanel`：创建、查看、改名、删除和切换本地用户账户；切换后清空当前选中用户角色并刷新，让用户重新进入自己的角色。
- `JoinGate`：选择账号已有角色和目标地图并进入；不再提供创建角色入口。
- `TopBar`：提供 `🎯 我的角色` 管理入口。
- `UserCharactersPanel`：以格子面板展示当前账户下的用户角色，支持输入名称或简短描述创建角色；点击角色格子只选中查看，点击“应用”才切换当前操控角色，并可对角色改名/删除。
- `InventoryPanel`：展示当前用户角色背包物品。
- `UserCharacterController`：本地用户角色控制器。
- `RemoteUserCharacterManager`：同 scope 远程用户角色渲染。
- NPC 仍由 `CharacterMovement` 和 `characterSprites` 管理。

运行时原则：

- 进入世界后默认操控选中的用户角色。
- 不再让用户点击“化身”切换玩家模式。
- “上帝视角”只作为观察/管理工具，不是玩家模式。
- 本地用户角色和远程用户角色用用户角色系统渲染。
- NPC 用 NPC 系统渲染、移动和决策。

后续 UI 应新增：

- 背包面板：展示 `inventory_entries`，后续增加使用、丢弃、交换和摆放动作。
- 交换面板：同 scope 用户角色之间交换物品。
- 地图物品交互：拾取、摆放、查看。
- 角色交互菜单：对 NPC 或其他用户角色发起聊天、赠送、交易、协作等。

当前 `UserCharactersPanel` 已接入用户角色素材生成：创建角色时把用户输入作为提示词，后端复用 `generators/character` 的 spritesheet 生成、绿幕裁切和 metadata 管线，生成临时 `char_*` 产物后复制到当前世界的 `user-characters/<userCharacterId>/` 目录，并把 `appearance.spriteKey/spriteUrl/assetStatus/prompt/sourceCharId` 写回用户角色。

用户角色素材与 NPC 素材分开存放：

- NPC：`characters/<npcId>/spritesheet.png`，通过 `/assets/characters/<npcId>/spritesheet.png` 访问。
- 用户角色：`user-characters/<userCharacterId>/spritesheet.png`，通过 `/assets/user-characters/<userCharacterId>/spritesheet.png` 访问。

前端渲染规则：

- `UserCharactersPanel` 有 `appearance.spriteUrl` 时在格子中显示生成出的 spritesheet 缩略图。
- `UserCharacterController` 创建本地操控角色时优先加载 `appearance.spriteUrl`，加载成功后使用用户角色自己的精灵图。
- `RemoteUserCharacterManager` 渲染同 scope 远程用户角色时同样优先加载对方的 `appearance.spriteUrl`。
- 没有素材的旧用户角色继续显示圆形默认外观，作为历史数据兼容。

## 与 NPC 的区别

用户角色：

- 属于某个 `UserAccount`。
- 可由用户创建多个。
- 由用户输入控制移动、采集和交互。
- 在线状态由 WebSocket 连接驱动。
- 可以进入任意已解锁地图。
- 背包归属到 `ownerType = "user_character"`。
- 不参与 NPC 的 AI tick 自动决策。
- 不使用 NPC 记忆系统作为主记忆。

NPC：

- 属于世界，不属于用户账户。
- 使用 `characters/` profile 和 `character_states`。
- 参与 simulation tick。
- 由 LLM/规则驱动行动、对话、记忆和情绪。
- 可作为 `ActorRef` 的交互目标。
- 后续可以持有物品，背包归属到 `ownerType = "npc"`。

## 时间线规则

每条时间线有自己的 SQLite `state.db`。用户角色运行态、背包、地图物品摆放、交换记录和关系状态都属于时间线运行态。

创建新时间线时：

1. 读取当前时间线中的用户角色快照。
2. 保留每个角色自己的 `worldId` 和 `currentMapId`。
3. 将 `timelineId` 改为新时间线 ID。
4. 复制角色坐标、动作、在线状态摘要。
5. 后续应同时复制 `inventory_entries`、`map_item_placements` 和 `actor_relationships`。

切换时间线时：

- 重新初始化当前 timeline DB。
- 重新加载用户角色运行态。
- WebSocket 客户端应重新确认 presence。
- 前端应刷新或重新加载当前角色所在地图。

## 资源、背包和物品边界

资源系统是世界内的通用货币/能量账户，用于角色生成、地图生成、物品生成等付费行为。采集请求携带 `userCharacterId` 时，服务端只用它校验该角色所在 `PresenceScope` 内确实存在对应资源点；采集成功后只增加资源账户，不写入 `item_definitions`、`item_instances`、`inventory_entries` 或 `item_transfers`。

物品系统是独立的 AI 生成与摆放系统，不由采集资源直接产出。玩家后续应通过“生成物品”入口输入提示词，例如家具、小建筑、装饰、工具等，由生成管线创建 `ItemDefinition`/素材/占地规则，再把生成出的 `ItemInstance` 放入角色背包。物品可以被放置到地图中，用来布置玩家想要的场景。

`GET /api/user-characters/:id/inventory` 可查询当前账户下指定用户角色的背包，但背包内容来自物品生成、拾取、交易、系统奖励等物品系统事件，不来自资源采集。

后续实现顺序：

1. 采集资源继续只增加资源账户。
2. BuildPanel 和生成系统继续用资源账户支付成本。
3. 新增“AI 生成物品”API，消耗资源并生成可放置物品。
4. 背包 UI 读取 `inventory_entries`，只展示真实物品。
5. 物品交换、摆放、拾取只操作物品表和摆放表。

## 当前实现边界

已经完成：

- 独立 `users/user_characters/user_character_runtime` 表。
- 全局账号库 `output/auth.db`，支持用户名/密码注册、登录、session token、退出登录。
- HTTP `Authorization: Bearer <token>` 和 WebSocket `token` 账户上下文。
- 强制登录门：未登录不能访问游戏 API、WebSocket 或前端游戏主界面。
- HTTP `x-user-id` 和 WebSocket `uid` 兼容调试路径。
- 世界目录 `worldx.meta.json` 记录 `ownerUserId/visibility`。
- 新生成世界归属创建账号；世界列表、切换和删除按账号权限过滤。
- 本地多用户账户 API：`GET /api/users`、`GET /api/users/me`、`POST /api/users`、`PATCH /api/users/:id`、`DELETE /api/users/:id`。
- 前端 `用户/账号` 面板，可注册、登录和退出账号，并在账号变化时清理当前角色选择。
- 用户角色列表、创建、进入地图按账户过滤和校验。
- 用户角色 API 支持列表、创建、改名、删除；删除带在线、背包、地图摆放物保护。
- `MapRuntimeRegistry` 作为 `PresenceScope -> MapRuntime` 的第一层索引。
- `/api/world/maps` 和 `/api/build/state` 返回 `mapRuntimes`。
- `POST /api/build/collect` 支持 `userCharacterId`，并按用户角色 presence 校验资源点；成功后只增加资源账户，不写入背包物品。
- `GET /api/user-characters/:id/inventory` 查询用户角色背包。
- 前端 `InventoryPanel` 可查看当前用户角色背包。
- `POST /api/items/place` 支持把背包物品摆放到当前地图，并按可行走 tile 校验。
- `GET /api/items/placements` 查询当前地图已摆放物品。
- `POST /api/items/generate` 支持消耗资源，根据提示词生成可摆放物品并放入用户角色背包。
- 背包面板支持输入提示词生成家具、小建筑或装饰物。
- 背包可摆放物品支持进入地图摆放模式，点击可行走 tile 后调用摆放 API 并在 Phaser 中渲染占位物。
- 摆放物 footprint 会写入前端 runtime 动态阻挡层并刷新寻路；服务端拒绝 footprint 重叠。
- `user_character_runtime` 保存 `world_id/timeline_id/current_map_id`。
- `GET /api/user-characters`、`POST /api/user-characters`、`POST /api/world/map/enter`。
- WebSocket 用户角色事件按 presence scope 隔离。
- 前端选择/创建用户角色入口。
- 前端 `我的角色` 格子面板，可创建角色、查看角色列表；点击格子只选中查看，点击“应用”才切换当前操控角色，并可改名/删除。
- 新账号注册时创建两个默认固定角色；登录、角色列表查询和进入地图页不再临时补角色。
- 用户角色创建已复用 NPC 角色 spritesheet 生成管线，生成结果写入 `user-characters/<userCharacterId>/` 并通过 `appearance.spriteUrl` 加载。
- `UserCharacterController`、`RemoteUserCharacterManager` 作为用户角色渲染入口。
- `player_avatar` 作为兼容镜像保留。
- 物品和交互扩展所需的 `ActorRef`、`PresenceScope`、物品相关类型和 DB 表。

仍未完成：

- 账号体系仍是本地轻量认证，没有接入正式 OAuth/邮箱验证/找回密码/管理员权限。
- 世界成员授权、邀请链接、访问申请和世界公开/私有切换 UI；当前只有可见性 API。
- 完整 per-map room runtime。当前服务器仍有全局 active map，`MapRuntimeRegistry` 只是第一阶段索引。
- 物品素材生成、背包物品使用、丢弃和交换操作。
- 地图物品拾取、移动、删除，以及服务端/多端同步动态阻挡层。
- 玩家之间交换物品。
- 用户角色和 NPC 的结构化交互 API。
- WebSocket 事件名从 `player_*` 迁移到 `user_character_*`。

## 后续实施顺序

1. 世界访问层：新增世界成员/邀请表，支持 owner 邀请其他账号进入自己的世界。
2. 房间层：把全局 active map 拆成 `PresenceScope -> MapRuntime`，进入他人世界不再改全局 active map。
3. 账号层：替换本地 `output/auth.db` 为正式认证服务，补齐密码找回、会话过期刷新和管理员权限。
4. 背包层：补齐物品使用、丢弃、转移 API。
5. 地图物品层：补齐地图物品拾取、删除、移动和多端同步动态阻挡层。
6. 交换层：实现同 scope 用户角色之间的交换请求、确认、取消和事务提交。
7. 交互层：用 `ActorRef` 实现用户角色与 NPC、用户角色与用户角色的统一交互。
8. 兼容清理：逐步减少 `player_avatar`、`PlayerController`、`player_*` 命名的主路径使用。
