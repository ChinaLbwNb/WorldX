# 地图扩展管线集成修复规划

## 问题概述

对照生成管线文档和架构文档审查后，发现扩展管线本身（6 步生成流程）是正确的，但扩展完成后与运行时的集成存在 3 个问题，导致新区域虽然在地图上可见，但在游戏逻辑中"不存在"。

## 问题分析

### 问题 1：reloadAfterExpansion 不完整

**现状**：`world-manager.ts` 的 `reloadAfterExpansion()` 只调用了 `loadCollisionGrid()`，仅刷新碰撞网格和 worldSize。

**缺失项**：
- `mainAreaPoints` 邻接图未重建 —— 新区域的可行走路径不会反映到角色寻路图
- `preferredMainAreaPointIds` 未更新 —— 新区域的主区域点不加入出生池
- `locationConfigs` 未重载 —— `world.json` 未更新（见问题 2），新区域不出现在 `getLocations()` 返回中

**影响**：扩展后新区域的碰撞网格可用（角色可以走过去），但新区域不会有主区域路径点，新生成角色不会出生在新区域，`getLocations()` 也不显示新区域。

### 问题 2：world.json 未更新

**现状**：扩展管线更新了 `06-final.tmj`（含新区域/元素的 object 层）和 `world-design.json`，但没有更新 `world.json`。`WorldManager` 从 `world.json` 读取 `locationConfigs` 和 `mainAreaPoints`。

**影响**：
- `getLocations()` 不返回新区域
- `getLocationObjects()` 不包含新交互物件
- `ResourceManager.discoverResourceNodes()` 的方式 1（从 location objects 找）不会发现新资源点（但方式 2 从 TMJ fallback 仍可发现）

### 问题 3：客户端无热重载

**现状**：`BuildPanel` 轮询到 job 完成后只更新 buildState，不触发 Phaser 场景重启。`BootScene` 在启动时加载 TMJ 和背景图，扩展完成后客户端需要手动刷新页面才能看到新地图。

**影响**：用户体验差，扩展完成后看到 flash 提示但地图不变化。

## 修复方案

### 修复 1：扩展管线写入 world.json

在 `expand-map.mjs` 的 Step 6 中，`buildCombinedTMJ` 之后增加 `updateWorldJson` 步骤：

1. 读取现有 `world.json`
2. 根据 TMJ 新增的 regions 层，为每个新区域生成 `LocationConfig` 追加到 `locations` 数组
3. 根据 TMJ 新增的 interactive_objects 层，为每个新元素生成 `ObjectConfig` 追加到对应 location 的 `objects` 数组
4. 为新区域生成 `MainAreaPointConfig`（在区域中心找可行走点），追加到 `mainAreaPoints` 数组
5. 写回 `world.json`

新增辅助函数 `updateWorldJson(worldDir, finalTMJ, oldTMJ, direction, newRegions, newElements, newGrid, tileSize, oldBgWidth, oldBgHeight, newRegionBgWidth, newRegionBgHeight)`：

- 读取 `world.json`
- 从 `finalTMJ.layers` 中解析出所有 regions 和 interactive_objects
- 筛选出新区域和新元素（通过对比 oldTMJ 的对象 id 范围）
- 为每个新区域创建 `LocationConfig`：id 取 TMJ region 的 name slug，name 取 region name，description 取 region description，adjacentLocations 填充相邻区域 id
- 为每个新元素创建 `ObjectConfig`：id 取 TMJ object 的 objectId property，name 取 name，locationId 填对应区域 id，defaultState 设为 "idle"，interactions 设为默认交互列表
- 为每个新区域创建 `MainAreaPointConfig`：在区域的 TMJ 坐标范围内，从合并后的碰撞网格中找第一个可行走格作为路径点，id 格式 `map_expand_{direction}_{regionId}`
- 新主区域点的 `adjacentPointIds` 设为空数组（由 `rebuildMainAreaPointAdjacencyFromTmj` 在运行时重建）

### 修复 2：reloadAfterExpansion 完整重载

修改 `world-manager.ts` 的 `reloadAfterExpansion()`：

1. 调用 `loadWorldConfig(worldDir)` 重新读取 `world.json`（需先调用 `invalidateWorldConfigCache()` 清缓存）
2. 执行 `normalizeLocations()` 重新归一化区域配置
3. 调用 `loadCollisionGrid()` 重载碰撞网格和 worldSize
4. 调用 `rebuildMainAreaPointAdjacencyFromTmj()` 重建主区域点邻接图和 `preferredMainAreaPointIds`

### 修复 3：ResourceManager 扩展后重新发现

修改 `resource-manager.ts`，新增 `rediscoverAfterExpansion()` 方法：

1. 清空 `this.resourceNodes`
2. 重新调用 `this.discoverResourceNodes()`

修改 `map-expander.ts`，在 `worldManager.reloadAfterExpansion()` 之后调用 `resourceManager.rediscoverAfterExpansion()`。需要给 `MapExpander` 构造函数注入 `ResourceManager` 引用。

### 修复 4：客户端热重载

方案：扩展完成后触发 Phaser 场景重启。

**服务端**：`map-expander.ts` 在 job 完成消息中明确返回 `requiresReload: true` 标记。

**客户端**：`BuildPanel.tsx` 检测到 job done 时：
1. 通过 `eventBus.emit("map_expanded")` 发送事件
2. `WorldScene` 监听 `map_expanded`，执行 `this.scene.restart()` 或 `this.scene.start("BootScene")` 重新加载资源
3. `App.tsx` 监听 `map_expanded`，触发 `window.location.reload()` 做完整刷新（最简单可靠的方案）

选择 `window.location.reload()` 方案，因为 Phaser 场景重启无法可靠地清除旧纹理缓存，而完整刷新保证所有资源（TMJ、背景图、精灵图）从服务端重新加载。扩展完成时给用户一个确认提示。

## 修复顺序

1. 修复 1（expand-map.mjs 写入 world.json）—— 基础数据
2. 修复 2（reloadAfterExpansion 完整重载）—— 运行时加载
3. 修复 3（ResourceManager 重新发现）—— 资源点
4. 修复 4（客户端热重载）—— 用户体验
5. 编译验证

## 验证标准

- 扩展后 `getLocations()` 返回新区域
- 扩展后 `getBuildState().resourceNodes` 包含新资源点
- 扩展后 `worldManager.collisionGridWidth/Height` 反映新尺寸
- 扩展后 `worldManager.preferredMainAreaPointIds` 包含新区域的主区域点
- 扩展完成后客户端自动刷新，显示新地图
- TypeScript 编译 + JS 语法检查通过
