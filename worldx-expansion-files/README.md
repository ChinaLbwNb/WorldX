# WorldX 地图扩展功能 - 文件包

## 内容

- `full-tracked-changes.patch` — 已有文件的修改补丁（对 main 分支的 diff）
- 15 个新增文件，保持原始目录结构

## 新增文件列表

### 生成管线
- `generators/map/src/expand-map.mjs` — 完整 6 步地图扩展管线
- `generators/map/prompts/expand-design-region.md` — 扩展区域设计提示词
- `generators/map/prompts/expand-map-generation.md` — 图像生成提示词
- `generators/map/prompts/expand-map-review.md` — 多模态审查提示词

### 服务端
- `server/src/core/map-expander.ts` — 地图扩展任务管理器
- `server/src/core/resource-manager.ts` — 资源采集系统
- `server/src/core/character-builder.ts` — 角色生成管理器
- `server/src/core/player-manager.ts` — 玩家状态管理
- `server/src/api/routes/build.ts` — 建造系统 API 路由
- `server/src/types/build.ts` — 建造系统类型定义

### 客户端
- `client/src/objects/PlayerSprite.ts` — 玩家精灵
- `client/src/ui/panels/BuildPanel.tsx` — 建造面板 UI

### 文档
- `docs/architecture.md` — 项目架构技术文档
- `docs/generation-pipeline.md` — 生成管线技术文档
- `docs/expansion-fix-plan.md` — 扩展修复规划文档

## 使用方法

```bash
# 1. 解压文件包
tar xzf worldx-expansion.tar.gz

# 2. 进入你的 WorldX 仓库
cd /path/to/your/WorldX

# 3. 创建并切换到 expansion 分支
git checkout -b expansion

# 4. 应用补丁（修改已有文件）
git apply worldx-expansion-files/full-tracked-changes.patch

# 5. 复制新增文件
cp -r worldx-expansion-files/* .

# 6. 提交
git add -A
git commit -m "feat: 地图扩展管线 + 集成修复"

# 7. 推送
git push origin expansion
```

## 修改的已有文件

补丁 `full-tracked-changes.patch` 包含以下文件的修改：

- `client/src/objects/CharacterSprite.ts` — 玩家交互点击
- `client/src/scenes/BootScene.ts` — 资源预加载
- `client/src/scenes/WorldScene.ts` — 资源标记、玩家移动、建造状态集成
- `client/src/types/api.ts` — 建造系统类型
- `client/src/ui/App.tsx` — BuildPanel 集成
- `client/src/ui/panels/TopBar.tsx` — 资源显示 + 建造按钮（修复了资源显示 bug）
- `client/src/ui/services/api-client.ts` — 建造 API 客户端
- `server/src/core/character-manager.ts` — 角色管理扩展
- `server/src/core/world-manager.ts` — reloadAfterExpansion 完整重载
- `server/src/index.ts` — 注册 build 路由
- `server/src/services/app-context.ts` — MapExpander 注入 ResourceManager
- `server/src/simulation/simulation-engine.ts` — 模拟引擎适配
- `server/src/types/character.ts` — 角色类型扩展
- `server/src/utils/config-loader.ts` — reloadConfigs 导出
