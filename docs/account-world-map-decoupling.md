# 账号、世界与地图节点解耦小规划

## 目标

把产品概念拆成清晰的四层：

- `Account`：账号，是资产归属边界。
- `World`：世界，是账号拥有的世界观与模拟容器。
- `MapNode`：地图节点，是世界内部的空间节点。
- `Presence`：运行态，表示某个账号角色当前进入了哪个世界、时间线和地图节点。

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

1. 将被选中的账号角色 presence 放到当前已加载的 world/timeline/map。
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
- `POST /api/world/map/travel`：只作为观察/管理兼容路径，不作为玩家进入世界入口。

## 前端调整

登录后的进入面板改为：

- 选择世界。
- 选择我的角色。
- 输入房间邀请码。
- 点击“进入世界”。

不再展示地图节点列表。进入世界后若要去其他地图节点，使用世界内地图 UI。

## 迁移阶段

### 当前小步

- 新增本文档。
- 新增 `/api/world/enter`。
- `JoinGate` 从“选地图节点”改为“选世界”。
- 进入世界默认落到 `map_origin/defaultMapNodeId`。

### 已完成

- 用户角色资产主表迁入账号 DB：`account_user_characters`。
- 用户角色运行态迁入账号 DB：`account_user_character_presence`。
- 资源货币迁入账号 DB：`account_resources`。采集、生成角色、生成地图节点、生成物品都只读写当前登录账号余额。
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
- 创建世界完成后的前端流程改走 `POST /api/world/enter`：选中当前账号角色，进入新世界默认地图节点，并刷新运行时。
- 建造面板的“生成角色”已改为账号用户角色生成入口：消耗当前账号资源，写入 `account_user_characters` 和 `output/account-assets/user-characters/`，不再把用户生成角色写成世界 NPC。
- 时间线管理列表只返回当前账号可访问的世界和示例库世界，避免泄露其他私有世界名称/ID。
- `/assets/account/...` 按登录账号校验资产所有权；`/assets/worlds/...`、旧兼容 `/assets/maps/...` 和 `/assets/characters/...` 按世界访问权限校验。前端同源图片通过 `worldx_session` 登录 cookie 读取素材。
- 未登录 `/api/health` 不再暴露当前私有世界名称和配置，只返回服务可用状态。
- 旧 `/api/users` 不再读写世界 DB 的 `users` 表；当前只返回/更新当前登录账号资料，创建账号统一走 `/api/auth/register`，账号删除在资产清理能力完整前显式禁用。
- `/api/world/enter` 已按联机语义收口：世界拥有者进入时恢复自己的世界时间线，访客进入已加载公开世界时复用当前运行时间线；多人 WebSocket 只在相同 `{ worldId, timelineId, mapId }` 内广播上线、移动和聊天。
- `/api/items/pickup` 已按账号归属校验摆放物；前端地图物品菜单对他人物品只显示归属提示和关闭，不提供收回按钮。
- 在线玩家管理已接入：`GET /api/world/online` 返回当前世界/时间线在线玩家；`POST /api/world/online/kick` 仅允许世界拥有者踢出访客；前端“在线”面板提供在线列表、邀请链接和踢出操作。

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

- `/api/build/character`：从“生成世界 NPC”改为“生成账号用户角色”。
- `/api/timelines/all`：从全世界扫描改为账号可访问世界扫描。
- 静态资产路由：账号素材、私有世界素材和旧兼容素材入口增加登录态与所有权校验。
- `/api/users`：从世界内旧用户表改为账号 DB 视图，避免用户 CRUD 落在世界维度。

### 下一阶段

- 地图节点从 `worldMaps` 独立成更明确的 `mapNodes` 命名。
- 把旧表迁移脚本固定为一次性迁移工具，运行时代码不再读取旧 `user_characters`/`inventory_entries`/`world_global_state.player_resources` 作为正常数据源。

### 风险

- 旧世界 DB schema 中仍存在历史表；它们只应作为迁移来源，不应成为新功能依赖。
- 旧时间线物理文件仍位于世界目录下；账号隔离由 `account_timeline_assets` 控制，后续如需云同步可再抽象为独立 timeline package。
