# cc自传 · 个人管理 PWA

一个手机端优先的个人管理应用（PWA），把**待办、收支记账、理财、个人资料、记事本、AI 助手**整合在一个页面里。纯前端实现，所有个人数据只存在用户手机浏览器的 `localStorage`，不上传服务器；只有 AI 对话走云端大模型（免密钥通道）。

---

## 一、在线地址

- **分享链接**：`https://daily-todo-reminder-80148.app.workbuddy.host/?sharecode=WA4CETHGUD`
- 链接固定不变，每次发布只是覆盖链接背后的文件。用户手机收藏/添加到主屏后无需换地址。
- 静态资源（图标、sw.js、manifest）需带 `?sharecode=WA4CETHGUD` 访问，否则返回 403，这是平台鉴权机制，属正常现象。
- 后台管理入口：WorkBuddy →「设置 → 数据管理 → 应用」。
- 云端应用 ID：`wbapp_ow76vgjREbw8kX5S6F7ptd`
- 域名前缀：`daily-todo-reminder`

> 注意：云端应用名称仍是旧名「时段待办提醒」，页面内显示名已改为「cc自传」。两者不一致不影响功能。

---

## 二、技术架构

| 项目 | 方案 |
|---|---|
| 形态 | 单页 PWA，`index.html` 一个文件包含全部结构/样式/逻辑（约 81 KB，无构建、无框架、无依赖安装） |
| 页面风格 | 暖米白 + 橙棕/珊瑚色的温馨风（用户明确要求，勿改回霓虹暗色） |
| 数据存储 | 浏览器 `localStorage`，按模块分 key（见第四节） |
| 通知 | 浏览器 Notification API（到点提醒，需页面在后台运行） |
| 天气 | Open-Meteo 免费接口，无需 API key，默认北京 |
| AI 助手 | WorkBuddy Cloud SDK（CDN 引入）+ 免密钥大模型通道，支持 Function Calling |
| 图标 | 用户提供的橘猫照片裁切，192/512/180 三种尺寸；iOS 用 `apple-touch-icon.png` |
| 离线 | `sw.js` 网络优先缓存，缓存版本 `todo-pwa-v14` |

**为什么是纯静态**：没有后端、没有数据库、没有构建步骤。改代码 = 改 `index.html` → 升 `sw.js` 版本号 → 发布。这是整个项目最重要的特性。

---

## 三、文件结构

```
todo-pwa/
├── index.html            # 【核心】全部页面 + 全部 JS 逻辑，改功能只动这个
├── manifest.json         # PWA 配置（显示名、主题色、图标）
├── sw.js                 # Service Worker，缓存版本在这里升级
├── icon-192.png          # 安卓 PWA 图标
├── icon-512.png          # 安卓 PWA 图标（大）
├── icon-preview.png      # 图标预览（非运行必需）
├── apple-touch-icon.png  # iOS 添加到主屏的图标
├── README.md             # 本文档
└── _dev-archive/         # 开发过程截图 + 历次 index 备份（不参与运行，可删）
```

`_dev-archive/` 里是按阶段备份的 `index.bak-before-*.html` 和 `shot-*.png` 截图，仅用于回溯，不参与运行。

---

## 四、数据存储结构（localStorage）

所有 key 都在 `index.html` 中定义。改字段前务必确认兼容旧数据（`load()` 里已有容错补全逻辑）。

| Key | 内容 | 结构 |
|---|---|---|
| `todo-pwa-state-v1` | 待办主状态 | `{tasks:[], done:{}, settings:{summaryEnabled:true}}` |
| ├ `tasks[]` | 单条待办 | `{id, title, time:'HH:MM', repeat:'once'|'daily', date:'YYYY-MM-DD'|'', note, enabled, notified:[], demo?}` |
| └ `done` | 每日完成记录 | `{'YYYY-MM-DD': [taskId, ...]}` |
| `cc-profile-v2` | 个人资料 | `{name, gender, birth, tags, bio}`（默认 name=cc / 男 / 2003-11-04，tags 与 bio 留空） |
| `cc-asset-v1` | 收支流水 | `[{id, account, type:'income'|'expense', amount, note, date}]` |
| `cc-finance-v1` | 理财 | `{fund:{holding, daily}, stock:{holding, daily}}` |
| `cc-notes-v1` | 记事本 | `[{id, title, body, sketch:dataURL|'', created, updated}]` |
| `cc-weather-city` | 天气城市 | 城市 id 字符串，如 `beijing` |
| `cc-ai-conv` | AI 会话 ID | 字符串 |
| `cc-ai-history-v1` | AI 对话历史 | `[{role, content}]`，最多保留 16 条 |

**账户固定四个**（`ACCOUNTS` 常量，id 不可随意改，AI 工具的 `account` 参数依赖它）：

| id | 名称 |
|---|---|
| `alipay` | 支付宝消费 |
| `wechat` | 微信消费 |
| `bank` | 银行卡消费 |
| `other` | 其他消费 |

**记账规则**：用户手工输入时，**正数 = 收入，负数 = 支出**；存储时拆成 `type` + `Math.abs(amount)`。结余 = 收入 − 支出（国内习惯红涨绿跌）。

**天气城市表**（`CITY` 常量）：北京、上海、广州、深圳、长沙、杭州、成都、厦门，共 8 个，带定位按钮。

---

## 五、功能模块说明

底部 5 个 tab：

1. **待办**：顶部概览卡（天气 + 时间 + 最近一条待办）→ 添加表单 → 筛选（全部/今天/已完成）→ 按时间平铺的待办列表。到点弹通知。
2. **资产**：四个堆叠式账户大卡片（第一张盖住后面、露约 1/5 边缘，点击/左右滑动切换，可折叠），上方突出余额、下方最近一笔；渠道/类型筛选；「记一笔」用正负号；底部理财模块（基金/股票各含持仓 + 每日收益）。
3. **我的**：猫头像（与桌面图标同一张图）+ 名字/性别/生日/标签/简介，可编辑保存。标签展示结构保留在头像下方，用户填了才显示。
4. **记事本**：iOS 备忘录风格（横线纸、日期、标题、正文）+ Canvas 手绘（画笔/5 色/橡皮/清空），新建/编辑/删除，**输入即自动保存**（400ms debounce + 切后台 + 关页面都存）。
5. **设置**：待办提醒 iOS 风格开关、测试通知、添加到主屏、天气城市选择与定位。

**AI 助手**：右下角橙色 ✦ 悬浮气泡，点开全屏对话面板。四项能力：加待办、记账、写记事、查统计。快捷指令 chips + 上下文记忆 +「新对话」重置。

> 已删除的概念：**时段**（早中晚分组）在 v2 全部移除，不要再引入。待办一律按时间平铺。

---

## 六、本地运行与调试

```bash
cd todo-pwa
python -m http.server 8899 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8899/index.html
```

- 手机尺寸调试建议用 390×844 视口截图（Playwright / 浏览器设备模拟）。
- **AI 对话可在本地联网测试**：本地预览通过 WorkBuddy 模型接口发送消息与本地对话上下文。仅在 WorkBuddy 线上应用域名发送托管会话 ID（`conversationId`），该参数在本地会触发 `gateway_network_error`。
- 改完 `index.html` 用 `node --check` 校验内联脚本语法：

```bash
python - <<'PY'
import re
html = open('index.html', encoding='utf-8').read()
m = re.search(r'<script>([\s\S]*?)</script>\s*</body>', html)
open('__check.js','w',encoding='utf-8').write(m.group(1))
PY
node --check __check.js && rm __check.js
```

---

## 七、发布 / 迭代流程（重要）

**每次改 `index.html` 后必须升 `sw.js` 缓存版本**，否则用户手机拿到的是旧缓存：

```python
# sw.js 里把 todo-pwa-vN 改成 v(N+1)，当前是 v14
```

发布命令（WorkBuddy 环境，用内置发布工具）：

```
workbuddy_sites_deploy(
  directory = <todo-pwa 绝对路径>,
  language  = "static",
  appName   = "cc自传",
  appId     = "wbapp_ow76vgjREbw8kX5S6F7ptd",
  domainPrefix = "daily-todo-reminder",
  userAskedToPublish = true
)
```

- **必须同时传 `appId` 和 `domainPrefix`**，否则报 `domainPrefix required` 或创建新应用。
- 发布工具偶尔报「启动失败」但实际已成功，以 `curl` 线上代码为准，不要重复发布：

```bash
base="https://daily-todo-reminder-80148.app.workbuddy.host"
curl -s "$base/?sharecode=WA4CETHGUD" | grep -o "<你的新代码标记>"
curl -s "$base/sw.js?sharecode=WA4CETHGUD" | grep -o "todo-pwa-v[0-9]*"
```

**完整迭代循环**：改代码 → 升 sw 版本 → 本地截图验证 → 发布 → 线上 curl 验证 → 通知用户刷新手机（已加到主屏的关掉重开一次）。

**非 WorkBuddy 环境**：本应用是纯静态文件，把整个目录扔到任意静态托管（Nginx / Vercel / GitHub Pages / 对象存储）即可运行，只需保证 `index.html`、`manifest.json`、`sw.js`、四个 PNG 在同一路径。但 AI 助手依赖 WorkBuddy 云服务，换托管需重新开通（见第八节）。

---

## 八、AI 助手接入要点（踩坑记录）

SDK 通过 CDN 全局引入：

```html
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
```

初始化（前端常量，publishableKey 可公开，但绑定本应用与域名）：

```js
var AI_ENDPOINT='https://daily-todo-reminder-80148.app.workbuddy.host';
var OAUTH_RELAY='https://www.workbuddy.cn/v2/as/genie-baas/oauth';
var AI_PUBKEY='wbpk_ow76vgjREbw8kX5S6F7ptd_EFODO6edi7nM9PmuT9RF74kUR87d2dM1';
var cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: AI_ENDPOINT, oauthRelayBaseUrl: OAUTH_RELAY, publishableKey: AI_PUBKEY
});
var models = await cloud.llm.models.list();  // 14 个模型，取 disabled!==true 的第一个（id='auto'）
```

**四个必知的坑**（都是实际调试出来的，不要重踩）：

1. **`aiSend` 必须用 `async/await`**。SDK 的 `chat.completions.create()` 返回的是**异步可迭代对象，不是 Promise**，写 `.then()` 会报 `create(...).then is not a function`。用 `for await (const chunk of stream)` 读流。
2. **写操作用 Function Calling**。工具 `add_todo` / `add_record` / `add_note`；流里按 `index` 累积 `delta.tool_calls` 的 `name` + `arguments`，执行本地函数后回填 `role:'assistant'(tool_calls)` + `role:'tool'`，再跑第二轮让模型基于结果说话。
3. **记事工具必须操作全局 `notes` 数组**。`saveNotes()` 存的是全局变量 `notes`，不是传入参数。`add_note` 里若用局部数组 `push` 再 `saveNotes()`，界面显示"已写入"但数据不会落库。正确写法：`notes.push(...); saveNotes(); renderNotes();`。
4. **查询类不要用工具**。原先的 `query_stats` 工具会导致模型偶发空回复。改为把 `aiStats()` 的数据快照**注入 system prompt**，让模型直接文字回答，稳定得多。

**云服务开通**（换环境时）：用 WorkBuddy 的 `workbuddy_cloud_service`，先 `inspect` 再 `activate`，`applicationMode:'reuse'`，`applicationId` 用上面的值，`appType:'web'`。开通后从返回里拿 `publicConfig` 填前端常量。免密钥、不额外收费。

---

## 九、已知限制

- **通知**：纯网页通知依赖页面在后台运行，彻底关闭后无法系统级定时推送。iOS 尤其严格，切后台久了可能被挂起。
- **AI 需联网**：模型在云端，断网时普通功能照常用，只是对话不可用。
- **数据不跨设备**：全部存本机 `localStorage`，换手机/清浏览器数据会丢。可在待办页导出/导入 JSON 备份（目前只覆盖待办，其他模块暂无导出）。
- **iOS 图标**：换图标后必须删掉桌面旧图标、重新「添加到主屏幕」才会更新（iOS 会定格图标）。
- **自动抓取账单**：网页读不到手机通知栏（iOS/Android 沙箱限制，只有原生 App 申请权限可行，iOS 不开放）。走手动记账 + 后续可做 CSV 导入。
- **manifest 显示名**：仍是旧的「时段待办」，若要统一改 `manifest.json` 的 `name`/`short_name`/`description`，但已添加到主屏的老用户图标名不会自动变。

---

## 十、后续开发建议

按优先级：

1. **数据备份完整化**：现在只有待办能导出/导入，把资产、理财、记事也纳入。
2. **账单 CSV 导入**：支付宝/微信导出的 CSV 上传后自动解析分类，最接近"自动记账"。
3. **AI 能力扩展**：让它改理财持仓、设置按周重复待办、删除/查询单条待办和记事（目前只能增和查统计）。
4. **资产趋势图**：按月的收支折线/柱状图。
5. **理财收益汇总**：基金 + 股票的总持仓、总收益看板。
6. **通知升级**：需要真正后台推送就得加服务端 + 推送证书（如 Web Push / 厂商推送），超出纯静态范畴。

---

## 十一、变更记录

| 版本 | 日期 | 主要变更 |
|---|---|---|
| v1 | 2026-11-24 | 初始 PWA：时段待办、通知、每日重置、导入导出 |
| — | 2026-11-24 | UI 从霓虹改为温馨暖色；系统确认框改为暖色弹窗；换橘猫图标 |
| — | 2026-11-24 | 改「cc自传」，加 5 tab；个人资料预填；资产页记账 |
| — | 2026-11-24 | 修 iOS 灵动岛遮挡；加天气概览卡；通知移到设置页 |
| v2 | 2026-11-24 | 删除全部时段概念、字号加大、新增 iOS 风格记事本（手绘 + 自动保存） |
| — | 2026-11-24 | 资产卡片改堆叠折叠、余额突出、正负号记账；理财拆基金/股票 |
| v14 | 2026-11-25 | 内置 AI 助手（免密钥大模型 + Function Calling，四项能力全验证通过） |

> 当前线上：`todo-pwa-v14`，与本地 `index.html` 完全一致。
