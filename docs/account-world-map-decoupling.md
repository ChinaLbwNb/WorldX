# 账号、世界与地图节点解耦小规划

## 目标

把产品概念拆成清晰的四层：

- `Account`：账号，是资产归属边界。
- `World`：世界，是账号拥有的世界观与模拟容器。
- `MapNode`：地图节点，是世界内部的空间节点。
- `Presence`：运行态，表示某个账号用户角色当前进入了哪个世界、时间线和地图节点。

用户登录后应该先选择进入哪个世界，而不是选择地图节点。进入世界后，系统自动进入该世界的默认地图节点。地图节点选择、传送和扩展只在世界内部的地图 UI 中出现。

## 分层规则

### Account

账号拥有统一资产：

- 用户角色。
- 物品与背包。
- 资源货币。
- 生成出来的世界。
- 后续可扩展的蓝图、建造资产、交易记录和权限关系。

角色、物品和资源不应该因为进入不同世界而复制为不同世界资产。它们可以出现在某个世界里，但归属仍然是账号。

### World

世界是账号资产之一，负责承载：

- 世界观、世界配置和 NPC 配置。
- 时间线集合。
- 地图节点集合。
- 世界级模拟状态。

世界生成完成时创建第一个地图节点，并把它标记为默认节点：

```ts
defaultMapNodeId: "map_origin"
```

兼容阶段可以继续使用 `activeMapId`，但产品语义上应区分：

- `defaultMapNodeId`：进入世界的默认节点。
- `activeMapId`：服务端当前加载的运行节点。

### MapNode

地图节点只属于某个世界内部，不拥有账号资产。它负责承载：

- 地图素材、TMJ 和碰撞/可行走数据。
- 地图内可交互点、资源点和摆放实例。
- NPC 或角色当前出现在该节点时的运行位置。

地图节点 UI 应放在进入世界之后，用于传送、生成新节点或查看节点关系。

### Presence

Presence 是运行态，不是资产归属：

```ts
{
  userId: string;
  characterId: string;
  worldId: string;
  timelineId: string;
  mapNodeId: string;
  x: number;
  y: number;
}
```

角色资产本体不绑定世界或地图；只有 presence 记录“当前在哪里”。

切换当前操控角色不是进入世界，也不是地图传送。它只做两件事：

1. 将被选中的账号用户角色 presence 放到当前已加载的 world/timeline/map。
2. 让前端本地控制器和 WebSocket 身份切换到该角色。

因此切换角色不应该触发整页刷新，也不应该改变当前世界。

## API 调整

新增语义化入口：

```ts
POST /api/world/enter
body: {
  worldId: string;
  userCharacterId: string;
}
```

服务端流程：

1. 校验账号能访问该世界。
2. 如果进入者是世界拥有者，则切换/恢复该世界在拥有者账号下的当前时间线；如果目标世界已经加载且进入者是访客，则加入当前运行中的世界时间线，避免访客把公开世界切成一条孤立时间线。
3. 解析世界默认地图节点，优先 `defaultMapNodeId`，兼容 `map_origin` 和当前 `activeMapId`。
4. 将用户角色 presence 放入该世界默认地图节点。
5. 返回 `requiresReload: true`，前端完整刷新。

保留：

- `POST /api/world/map/enter`：世界内部地图节点传送。
- `POST /api/world/map/enter`：玩家地图节点传送入口，必须带 `userCharacterId`；只更新该角色 presence，不切服务端全局 active map。旧 `POST /api/world/map/travel` 已移除。

## 前端调整

登录后的进入面板改为：

- 选择世界。
- 选择我的角色。
- 接受在线玩家发来的实时世界邀请。
- 点击“进入世界”。

不再展示地图节点列表。进入世界后若要去其他地图节点，使用世界内地图 UI。

## 迁移阶段

### 当前小步

- 新增本文档。
- 新增 `/api/world/enter`。
- `JoinGate` 从“选地图节点”改为“选世界”。
- 进入世界默认落到 `map_origin/defaultMapNodeId`。

### 已完成

- 地图节点对外数据合同从旧 `worldMaps` 收口到 `mapNodes`：
  - `world.json` 新写入字段使用 `mapNodes`。
  - 当前 world 数据已迁移为 `mapNodes`，运行时代码不再读取 `worldMaps`。
  - `/api/build/state` 只返回 `mapNodes`，前端不再读取 `worldMaps` 兼容别名。
- 用户角色资产主表迁入账号 DB：`account_user_characters`。
- 用户角色运行态迁入账号 DB：`account_user_character_presence`。
- 资源货币迁入账号 DB：`account_resources`。采集、生成账号用户角色、生成地图节点、生成地图 NPC、生成物品都只读写当前登录账号余额。
- 时间线资产索引迁入账号 DB：`account_timeline_assets`。时间线文件仍存放在对应世界目录下，但列表、加载、删除和创建都按账号过滤。
- 背包、物品定义、物品实例和交易记录迁入账号 DB：
  - `account_item_definitions`
  - `account_item_instances`
  - `account_inventory_entries`
  - `account_item_transfers`
- 用户角色生成素材和物品生成素材迁到账号级素材目录：`output/account-assets/`。
- 运行时通过 `/assets/account/...` 读取账号素材，不再从具体世界目录读取用户角色/物品素材。
- 世界 DB 只保留地图摆放实例 `map_item_placements`，因为摆放位置属于某个世界、时间线和地图节点的运行态。
- 背包 owner 统一为 `account`。用户角色只是操控实体，不再拥有独立背包。
- 旧的 `user_character` owner 背包和摆放记录会在读取账号背包时归并到账号 owner。
- `map_item_placements.item_instance_id` 引用账号 DB 中的 item instance id，世界 DB 不再对它建立本地外键。
- 地图摆放实例的收回权限按 `placed_by_owner_type/placed_by_owner_id` 校验；默认只有摆放归属账号可以收回，其他账号不能拆除或收走。
- 角色切换新增轻量路径：`POST /api/user-characters/:id/select`，返回 `requiresReload: false`。
- 生成世界写入账号世界资产索引 `account_world_assets`，并同步写入世界目录 `worldx.meta.json`。世界列表、管理权限和删除会同时参考账号资产表与世界元数据。
- 创建世界完成后的前端流程改走 `POST /api/world/enter`：选中当前账号用户角色，进入新世界默认地图节点，并刷新运行时。
- 建造面板入口统一命名为“生成 NPC”：消耗当前账号资源，但产物写入当前世界的 `characters/` 和 `config/characters/`，作为世界 NPC 加入模拟。账号用户角色只从“我的角色”面板创建，写入 `account_user_characters` 和 `output/account-assets/user-characters/`。
- 时间线管理列表只返回当前账号可访问的世界和示例库世界，避免泄露其他私有世界名称/ID。
- `/assets/account/...` 按登录账号校验资产所有权；`/assets/worlds/...`、旧兼容 `/assets/maps/...` 和 `/assets/characters/...` 按世界访问权限校验。前端同源图片优先通过 `worldx_session` 登录 cookie 读取素材；Phaser/Image 这类无法附加 Authorization header 的加载路径必须给 `/assets/...` URL 追加当前会话 `token` 查询参数。
- 未登录 `/api/health` 不再暴露当前私有世界名称和配置，只返回服务可用状态。
- 旧 `/api/users` 不再读写世界 DB 的 `users` 表；当前只返回/更新当前登录账号资料，创建账号统一走 `/api/auth/register`，账号删除在资产清理能力完整前显式禁用。
- `/api/world/enter` 已按联机语义收口：世界拥有者进入时恢复自己的世界时间线，访客进入已加载公开世界时复用当前运行时间线；多人 WebSocket 只在相同 `{ worldId, timelineId, mapId }` 内广播上线、移动和聊天。
- `/api/items/pickup` 已按账号归属校验摆放物；前端地图物品菜单对他人物品只显示归属提示和关闭，不提供收回按钮。
- 在线玩家和成员管理已接入：`GET /api/world/online?userCharacterId=...` 优先按当前用户角色的 `{ worldId, timelineId, mapId }` 返回当前世界在线玩家，并额外返回全平台在线玩家用于实时邀请；`POST /api/world/online/kick` 按目标玩家所在世界校验管理权限；前端“在线”面板提供全平台在线邀请、当前世界在线列表、成员查看/移除和踢出操作。
- 世界成员角色已落地：世界拥有者是隐式 `owner`；显式成员角色为 `admin/builder/viewer`。`owner/admin` 可管理成员、踢人和修改可见性，删除世界仅限 `owner`；`owner/admin/builder` 可生成地图节点、摆放和拾取地图物品；`viewer` 可进入、查看、聊天、交易和采集账号资源货币，但不能修改世界运行态。旧 `member` 会归一化为 `builder`，旧 `guest` 会归一化为 `viewer`。
- 世界所有权以 `worldx.meta.json.ownerUserId` 为唯一准入来源；`account_world_assets` 只作为账号世界列表和索引，不授予删除权，也不会因为 admin 修改可见性而转移 owner。

## 账号维度审查结果

### 必须属于账号的资产

- 用户角色：`account_user_characters`。
- 用户角色素材：`output/account-assets/user-characters/<characterId>/`。
- 账号资源货币：`account_resources`。
- 物品定义、物品实例、背包、交易记录：`account_item_definitions`、`account_item_instances`、`account_inventory_entries`、`account_item_transfers`。
- 物品素材：`output/account-assets/items/`。
- 用户生成世界：`account_world_assets` + 世界目录 `worldx.meta.json`。
- 账号可见时间线索引：`account_timeline_assets`。

### 可以留在世界/时间线维度的运行态

- NPC 配置和 NPC 素材：属于世界内容，不归属某个账号。
- NPC 记忆、日记、事件、快照、对象状态：属于某条世界时间线。
- 地图节点、地图素材、TMJ、资源点定义：属于世界内部空间。
- 地图摆放实例 `map_item_placements`：位置属于 `{ worldId, timelineId, mapId }`，但引用的 `item_instance_id` 属于账号 DB。
- 在线玩家连接：属于当前服务进程内的运行态，按 `{ worldId, timelineId, mapId }` 标记位置；断线、切地图和被踢都会更新在线注册表。

### 本轮修正的漏网项

- `/api/build/character`：恢复为“生成当前世界 NPC”，不再写入账号用户角色表；账号用户角色 CRUD 只走 `/api/user-characters`。
- `/api/timelines/all`：从全世界扫描改为账号可访问世界扫描。
- 静态资产路由：账号素材、私有世界素材和旧兼容素材入口增加登录态与所有权校验。
- `/api/users`：从世界内旧用户表改为账号 DB 视图，避免用户 CRUD 落在世界维度。
- `/api/items/place` 与 `/api/items/pickup`：成功后通过 WebSocket 广播 `map_item_placed/map_item_picked_up` 到同一 `{ worldId, timelineId, mapId }`，多人同屏不再依赖刷新才能看到摆放物变化。
- `/api/items/transfer/request` 与 `/api/items/transfer/:id/respond`：实现账号到账号的单向物品赠送。请求要求目标账号在同一地图在线，接受后直接把 inventory entry 和 item instance 归属迁到接收账号，并广播 `item_transfer_requested/item_transfer_completed/item_transfer_cancelled`。
- `DELETE /api/users/:id`：实现账号自删除闭环。删除当前账号的 session、资源、用户角色、角色 presence、物品定义/实例/背包、物品转移记录、世界资产索引和时间线资产索引；同时清理 timeline DB 中的 `player_avatar` 兼容镜像，并把该账号摆放物标为 `removed`。非当前运行中的账号世界目录会被删除，当前正在加载的世界目录会保留以避免运行时中断。
- 世界成员授权：新增 `account_world_members`。世界 `owner/admin` 可通过在线玩家列表邀请成员，也可移除成员；成员即使在 private 世界下也可进入。实时邀请接受后登记为 `viewer`，不会把已有 `builder/admin` 降级；踢出在线玩家时会同步撤销成员资格；前端在线面板已提供在线邀请、成员查看/移除和踢出操作。
- 在线列表作用域：`/api/world/online` 已支持 `userCharacterId` 查询参数；背包赠送候选人和在线面板都使用当前操控角色的 presence scope，而不是全局 active world/map。
- 地图物品作用域：新增服务端 `MapPackageLoader`，可按 `worldDir + mapId` 读取地图包 TMJ/collision；`/api/items/place`、`/api/items/pickup`、`/api/items/placements` 已按用户角色 presence scope 操作，不再要求角色所在地图等于全局 active map；摆放/拾取/查询会打开该 scope 对应 world/timeline 的 `state.db`，避免写入服务端全局 active DB。
- 地图物品作用域继续收口：`/api/items/generate`、`/api/items/delete` 也要求 `userCharacterId`，按该角色 presence 写入审计 scope；`/api/items/placements` 不再接受无角色的全局 active map fallback。
- 资源采集与建造状态作用域：`GET /api/build/state?userCharacterId=...` 和 `POST /api/build/collect` 带 `userCharacterId` 时直接使用该角色 scope 下的 map nodes、resource node 和 map runtime；`MapRuntimeRegistry` 会按 `{ worldId, timelineId, mapId }` 缓存地图包资源点，不再回落到全局 active map 的资源点表。若角色 presence 指向当前账号无权访问的世界，接口直接返回 403，不再用全局世界兜底。
- 时间线作用域：`GET /api/timelines`、`GET /api/timelines/current`、`POST /api/timelines`、`POST /api/timelines/:id/load`、`DELETE /api/timelines/:id` 和 `GET /api/timelines/:id/events` 都支持 `userCharacterId`。带角色时会按该角色 presence 解析 world/timeline，不再默认使用服务端全局 current timeline；无权限 world 会返回 403。
- 世界/地图进入作用域：`POST /api/world/enter` 和 `POST /api/world/map/enter` 已改为角色 presence 操作，不再调用 `WorldManager.travelToMap()` 或 `AppContext.switchWorld()` 切全局 world/map。切换“我的角色”只返回该角色现有 presence，不再重置坐标或把角色拉到全局 active map。
- 默认/样例世界公共化：`library/worlds` 下的两个默认世界是公共空间，不再复制到账号私有目录。所有已登录账号都能进入同一份 library world，并拥有 builder 权限；每个公共世界只允许保留一条固定 timeline，前端不提供新建/删除入口，后端也拒绝公共世界 timeline 增删。物品摆放、建造状态和资源运行态都以共享的 `{ worldId, timelineId, mapId }` 为 scope。用户生成世界仍按 owner/member 权限隔离。
- 多人时间线规则：账号进入自己拥有的世界时使用自己的最新 timeline；成员/访客进入他人世界时加入世界 owner 的当前/最新 timeline，并登记该 timeline asset 给访客可见。这样多人在同一 world/map 联机时共享同一个 `{ worldId, timelineId, mapId }` 运行态，而不是各自生成孤立 timeline。
- WebSocket 主事件名已迁到 `user_character_joined/user_character_left/user_character_moved/user_character_mode_changed/user_character_chat/user_characters_online`。
- 用户角色运行态 HTTP 入口统一为 `/api/user-character-runtime/*`，旧 `/api/player/*` 路由已从服务挂载中移除。
- NPC 数据读取已补齐账号/世界作用域：`/api/characters?userCharacterId=...`、公屏 `@NPC` 和“架空对话”会按当前用户角色 presence 所在 world 读取 NPC 配置；非当前全局 runtime 的世界会使用角色配置生成状态兜底，避免把其他世界的 NPC 名字、素材或对话上下文串入当前私有世界。
- 受保护素材加载已补齐会话 token：地图 TMJ、背景切片、DOM 背景兜底、NPC spritesheet、用户角色 spritesheet、远程玩家 spritesheet、背包物品图片、小地图预览和地图摆放物图片都会通过统一 `withAssetAuth()` 追加 `/assets/...` token，避免浏览器 cookie 缺失时出现黑底、兜底图或 403。
- 用户角色切换按 source presence 收口：`POST /api/user-characters/:id/select` 支持 `sourceUserCharacterId`，会把目标角色放到当前操控角色所在的 `{ worldId, timelineId, mapId }`，因此切换角色不切世界、不刷新，也不会被目标角色历史 presence 指向的旧世界权限卡死。
- 多人进入世界的 timeline 选择按 owner 当前 presence 优先：访客/成员进入他人世界时先读取世界 owner 当前用户角色所在 timeline；如果旧世界 metadata 的 `ownerUserId` 已悬空，则回落到进入者账号创建/读取 timeline，避免旧数据清理后外键失败。
- 新创建世界的旧单地图产物兼容：生成管线仍可能输出 `map/06-final.tmj`、`map/06-background.png` 和 `map/background-tiles/*`。`MapPackageLoader`、`WorldManager.getMapDir()` 和 `/assets/worlds/:worldId/maps/map_origin/*` 会在 `maps/map_origin` 不存在时回落到根目录 `map/`，保证新建世界在不切全局 runtime 的账号级进入流程中也能正确加载默认地图素材。

### 下一阶段

- 把旧表迁移脚本固定为一次性迁移工具，运行时代码不再读取旧 `user_characters`/`inventory_entries`/`world_global_state.player_resources` 作为正常数据源。
- `worldMaps`/`WorldMapsState`/`getWorldMaps` 兼容别名已从运行时源码移除，地图节点主路径统一为 `mapNodes`/`MapNodesState`/`getMapNodes`；`MapNodesState.maps` 旧响应别名也已移除。
- `/api/world/info`、`/api/world/time`、`/api/world/locations` 和 `/api/world/locations/:id/state` 已支持 `userCharacterId` 作用域参数。主路径会按用户角色 presence 读取对应 world/timeline/map 的地图包语义，不再依赖服务端全局 active world/map/timeline。
- 建立 `{ worldId, timelineId }` 级运行时注册表，减少 `AppContext.switchWorld/switchTimeline` 对全局 runtime 的依赖。
- 在单向赠送基础上已补齐双向交易报价、接收方确认/拒绝、事务提交、背包 UI 报价选择、请求过期、主动撤销和基础历史筛选；后续继续补更完整历史审计报表。
- 账号删除后续增强：支持删除前把世界或物品转移给其他账号，而不仅是直接清理。

### 风险

- 旧世界 DB schema 中仍存在历史表；它们只应作为迁移来源，不应成为新功能依赖。
- 旧时间线物理文件仍位于世界目录下；账号隔离由 `account_timeline_assets` 控制，后续如需云同步可再抽象为独立 timeline package。
