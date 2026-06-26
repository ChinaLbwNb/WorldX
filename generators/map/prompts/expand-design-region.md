你是一名游戏世界设计师。现在需要为一张已有地图向{{direction}}方向扩展一块新区域。

## 现有世界信息
- 地图描述：{{mapDescription}}
- 世界描述：{{worldDescription}}
- 扩展方向：{{directionText}}

## 现有功能区（在旧地图中）
{{existingRegions}}

## 现有可交互元素（在旧地图中）
{{existingElements}}

## 连接边界信息
新区域与旧地图在{{directionText}}边缘接壤，必须保证：
1. 如果旧地图边缘有道路/路径，新区域必须让道路自然延伸进来
2. 地形风格必须延续（如旧地图边缘是草地，新区域不应突然变成沙漠）
3. 建筑风格、植被类型、配色方案必须与旧地图一致
4. 新旧区域之间必须有清晰的可行走连接

## 设计要求
请为新区域设计：
1. **2-4个新功能区**（regions）：这些是新区域中的主要建筑/户外区域，必须有明确的功能和视觉描述
2. **2-5个新可交互元素**（interactiveElements）：这些是散布在新区域中的可交互物体，必须包含至少1个资源采集点（resource node），其余可以是摊位、装饰、NPC站等
3. 功能区和元素的位置提示（placementHint）应该相对于新区域描述（如"新区域西北角"、"靠近与旧地图连接的入口处"等）

## 资源采集点要求
必须包含至少1个资源采集点，id以"resource_"开头，类型适合当前世界风格（如矿点、树木、农田、宝箱等），玩家可以与之交互采集资源。

## 输出格式
请严格按照以下JSON格式输出，不要输出其他内容：

```json
{
  "regions": [
    {
      "id": "new_region_1",
      "name": "区域名称",
      "description": "区域详细描述",
      "type": "building 或 outdoor",
      "enterable": true或false,
      "placementHint": "位置提示（如新区域东侧、靠近连接边缘等）",
      "visualDescription": "视觉外观详细描述（建筑风格、颜色、材质等）",
      "interactions": [
        {
          "id": "action_id",
          "name": "动作名称",
          "description": "动作描述"
        }
      ]
    }
  ],
  "interactiveElements": [
    {
      "id": "resource_1",
      "name": "资源点名称",
      "description": "资源点描述",
      "placementHint": "位置提示",
      "visualDescription": "外观描述",
      "interactions": [
        {
          "id": "collect",
          "name": "采集",
          "description": "采集资源",
          "effects": [{"type": "character_need", "target": "resources", "value": 1}]
        }
      ]
    }
  ],
  "boundaryConnection": {
    "terrainAtBoundary": "边界处的地形描述（如石板路延伸、草地过渡、河流岸边等）",
    "continuingElements": "需要延续的元素（如道路、河流、围墙等）",
    "styleNotes": "风格延续要点"
  }
}
```