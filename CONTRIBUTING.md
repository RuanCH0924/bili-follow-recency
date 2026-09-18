# 贡献指南

感谢你有兴趣为 **B站关注摸鱼博主** 做贡献！本文档说明参与本项目的流程与规范。

---

## 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [开发环境](#开发环境)
- [代码规范](#代码规范)
- [提交规范](#提交规范)
- [Pull Request 流程](#pull-request-流程)

---

## 行为准则

- 尊重所有贡献者，禁止任何形式的人身攻击与歧视性言论
- 讨论聚焦于技术问题本身
- 本项目是非官方第三方工具，请勿在 Issue 中提交任何破解、爬取、账号交易相关内容

---

## 如何贡献

### 报告 Bug

提交 Issue 前请先搜索是否已有相同问题。报告时请尽量附上：

1. **浏览器与版本**：如 Chrome 120.0.6099.109
2. **插件版本**：见 `prototype/manifest.json` 中的 `version` 字段
3. **复现步骤**：从打开 popup 开始，逐步描述
4. **预期行为 vs 实际行为**
5. **日志信息**：
   - Service Worker 报错 → `chrome://extensions/` → 插件卡片 → 「Service Worker」控制台
   - popup 报错 → 右键插件图标 → 「审查弹出内容」控制台
6. **截图**：UI 类问题请附截图

> ⚠️ 提交日志前请**务必删除**其中可能包含的 `SESSDATA`、`buvid3` 等 Cookie 信息，以及你的 UID（如有隐私顾虑）。

### 功能建议

请重点说明**使用场景**而非功能名称。例如：

- ✅「我关注了 300 个 UP 主，想一次性取关所有超过 90 天没更新的账号，现在只能一个个点很麻烦」
- ❌「加一个批量取关功能」

### 提交代码

详见下方 [Pull Request 流程](#pull-request-流程)。

---

## 开发环境

### 环境要求

- Chrome / Edge 等 Chromium 内核浏览器（≥ 88）
- 一个已登录的 B 站账号（调试需要真实 Cookie）

### 本地开发

本项目**零依赖、无构建步骤**，克隆后即可直接开发：

```bash
git clone https://github.com/RuanCH0924/bili-follow-recency.git
cd bili-follow-recency
```

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 `prototype/` 目录
3. 修改代码后：
   - 改动 `popup.html` / `popup.js` / `popup.css` → 重新打开 popup 即可生效
   - 改动 `background.js` / `manifest.json` → 必须在扩展管理页点击 ↻ 重新加载

> **重要**：请勿在提交的代码中引入构建工具、包管理器或任何第三方运行时依赖，本项目坚持零依赖原则。

---

## 代码规范

### 通用

- 使用原生 ES2020+ 语法，不引入框架
- 使用 2 空格缩进，语句结尾加分号
- 字符串统一使用单引号（模板字符串除外）
- 命名：变量/函数用 `camelCase`，常量用 `UPPER_SNAKE_CASE`，CSS 类用 `kebab-case`

### 架构约束

请严格遵守现有的职责划分：

| 文件 | 职责 | 约束 |
| --- | --- | --- |
| `background.js` | Service Worker | 所有网络请求、Cookie 读取、任务状态机、缓存读写、批量取关 |
| `popup.js` | 弹出层逻辑 | 仅负责 DOM 渲染、排序、过滤、多选、UI 状态 |
| `popup.css` | 弹出层样式 | 使用 CSS 变量（定义于 `:root`）取色，不写死色值 |
| `manifest.json` | 扩展配置 | 新增权限需在 PR 中说明必要性 |

### 通信约定

popup 与 background **只能**通过 `chrome.runtime.sendMessage` 通信，消息类型为固定枚举：

| 方向 | type | 说明 |
| --- | --- | --- |
| popup → background | `start` / `reset` | 启动新任务（两者语义一致，旧任务会因 `runId` 失效而自动退出） |
| popup → background | `cancel` | 取消当前任务并中止在途请求 |
| popup → background | `query-state` | 查询当前任务状态 |
| popup → background | `refresh-one` | 单项刷新，只重查一个 UP 主（`mid`） |
| popup → background | `unfollow` | 批量取关，`mids` 为 UID 数组 |
| background → popup | `item` | 单个 UP 主的查询结果，payload 为 `{ mid, runId, item }` |
| background → popup | `progress` | 查询进度，payload 含 `mid` / `runId` / `stage` / `current` / `total` / `etaMs` |
| background → popup | `task-state` | 任务状态变更，payload 为 `{ status, mid, runId, error }` |
| background → popup | `unfollow-progress` | 批量取关进度，payload 为 `{ current, total, mid, ok, error }` |

**重要**：所有 background → popup 的推送都必须携带 `mid`（和 `runId`），popup 端据此过滤，否则切换 UID 时会出现数据串台。

新增消息类型时请同步更新本表与 README。

### 请求频率

请勿提高 `CONCURRENCY` 或降低 `REQUEST_INTERVAL`。当前值（并发 5 / 间隔 80ms）是在可用性与风控风险之间权衡后的结果，擅自提高可能导致使用者的账号被限流。

取关请求必须保持**串行**且不缩短 `UNFOLLOW_INTERVAL`（400ms）——写操作比读操作更容易触发风控。

### 隐私红线

- 禁止将用户的 Cookie、UID、关注列表等任何数据发送到 B 站官方接口之外的任何服务器
- 禁止在代码中硬编码任何真实的 `SESSDATA` / `buvid3` 值
- 调试用日志在提交前必须移除

---

## 提交规范

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <subject>
```

**type 取值**

| type | 含义 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 样式调整（不影响逻辑） |
| `refactor` | 重构（既非新功能也非修复） |
| `perf` | 性能优化 |
| `chore` | 构建 / 工具 / 杂项 |

**scope 取值**：`popup` / `background` / `ui` / `docs` / `manifest`

**示例**

```
feat(popup): 支持按停更时长分组展示
fix(background): 修正缓存键与 popup 不一致的问题
docs(readme): 补充 SESSDATA 鉴权说明
```

---

## Pull Request 流程

1. **Fork 本仓库**，并从 `main` 分支创建你的特性分支

   ```bash
   git checkout -b feat/group-by-staleness
   ```

2. **完成开发**，自测通过。提交前请确认：
   - [ ] 已在本地加载扩展并实际跑通一次完整查询
   - [ ] 未引入任何第三方依赖
   - [ ] 未提交任何 Cookie、UID 等敏感信息
   - [ ] 已同步更新 `CHANGELOG.md` 的 `Unreleased` 段落
   - [ ] 若修改了用户可见行为，已同步更新 `README.md`

3. **提交并推送**

   ```bash
   git commit -m "feat(popup): 支持按停更时长分组展示"
   git push origin feat/group-by-staleness
   ```

4. **发起 Pull Request**，在描述中说明：
   - 这个 PR 解决什么问题
   - 具体改了哪些文件、为什么这样改
   - 如何验证（复现步骤 / 测试方式）
   - 关联的 Issue 编号（如有）

5. **等待 Review**。维护者可能会提出修改意见，请在同一分支继续提交，PR 会自动更新。

### Review 关注点

- 是否遵守零依赖原则
- 是否遵守 background / popup 的职责划分
- 是否影响请求频率与风控安全
- 是否有隐私泄露风险
- UI 变更是否与现有设计语言一致

---

## 许可证

提交贡献即表示你同意你的代码以本项目的 [MIT License](LICENSE) 协议发布。
