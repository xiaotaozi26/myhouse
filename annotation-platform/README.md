# AI短剧标注平台（annotation-platform）

基于 `FS-P001` 短剧标注交接包搭建的独立 Web 标注平台，提供四个标注页面、任务分配、结果回传与逐集复核返修。

> 支持每集每项任务独立分配、结果回传和复核返修。

## 技术选型

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.6（开发用 24） | 依赖 `node:sqlite` 与原生 TypeScript 类型剥离 |
| 后端 | Express 5 + TypeScript | `node server/index.ts` 直接运行，**零构建**（Node 24 原生剥类型） |
| 存储 | SQLite（`node:sqlite`，无原生编译）+ 文件目录 | 账号/分配/结果元数据入库；结果文件与原始数据落盘 |
| 鉴权 | `node:crypto` scrypt + HMAC 会话 Cookie | 无 bcrypt/无外部会话依赖 |
| 前端 | 原生 HTML/CSS/JS（静态托管） | 无打包器 |
| 标注页 | `vendor/` 内的 4 个单文件 HTML | 沿用原工具的数据格式和质检轮次，支持较大的右侧核对按钮与批量核对 |

唯一的运行时依赖是 `express`；`typescript` / `@types/*` 仅用于类型检查，不是运行必需。

## 目录结构

```text
annotation-platform/
  server/
    index.ts                     入口：静态托管、挂载路由、种子管理员
    config.ts                    端口/路径/任务常量
    db.ts                        SQLite 打开与建表
    auth.ts                      scrypt、会话、鉴权中间件
    routes/
      auth.routes.ts            登录/登出/me/改密
      admin.routes.ts           账号、批次、分配、结果（管理员）
      annotator.routes.ts       我的任务、下载数据、回传结果
    services/
      batch.service.ts          批次导入、数据切片
      assignment.service.ts     分配、作业分组、结果提交
  public/                       门户前端（登录、管理后台、我的任务）
  vendor/                       4 个原始标注页（people/assets/shots/story.html）
  data/                         运行时数据
    incoming/<批次>/            manifest.json + primary.jsonl
    results/                    已回传的结果与记录表
    platform.sqlite             数据库
```

## 快速开始

```bash
cd annotation-platform

# 1) 安装依赖（若使用本机 Node；开发环境用沙箱自带 Node 时参考下文）
npm install            # 或 pnpm install

# 2) 启动（端口默认 3210，可用 PORT 覆盖）
node server/index.ts   # 或 npm start

# 3) 打开 http://127.0.0.1:3210
#    初始管理员：admin / admin123（可用环境变量 ADMIN_PASSWORD 覆盖）
```

> 本仓库在开发沙箱里用的是自带 Node（`~/.dsh/.../dependencies/node/bin/node`）与 pnpm。示例启动：
> `node server/index.ts`，首次运行会自动建库并打印管理员账号。

## 批次生产要求

- **中文场景道具依据**：剧集语言为中文时，预填依据须直接根据原片画面用中文生成。写清楚画面里可观察到的物件、动作或场景特征。引用画面文字时保留原文。
- **证据时间点**：每条预填依据至少附一个能在原片中回看的证据时间点，以本集视频起点为零点，单位为秒。例如「医生手持文件说明病情」，证据时间点为本集 `18.4` 秒。无法从画面确认的内容留待核对。
- **历史批次兼容**：交来的中文剧集已有英文预填依据时，平台可在导入阶段使用本机翻译。翻译沿用源数据提供的证据时间，未提供的时间由生产方或标注员看原片补齐。

## 使用流程（供应商管理员视角）

1. **导入批次**：每个批次在 `data/incoming/` 下单独建一个文件夹，名称与清单里的批次编号一致。放入 `manifest.json` 和 `primary.jsonl`，在「批次与进度」页点「刷新批次列表」，再点新批次旁的「导入」。
2. **建账号**：在「账号」页为每位标注员建账号（角色选「标注员」，用户名如 `A01`）。
3. **分配**：在「任务分配」选择批次和剧集，为各任务选择标注员。可以同时选复核人和优先级。每集每项任务只分配一份标注。标注员工作台优先显示紧急和优先任务，可打开具体剧集。
4. **标注与提交**：标注员从「我的任务」打开标注页。每集核对完成后点「完成并提交」，平台保存结果并打开下一集待处理任务。已指定复核人的作业自动进入其待办，其余在管理后台显示「待管理员指派」。
5. **审核与返修**：审核人从工作台打开对应剧集，在标注页选择审核结论后点「完成并提交」。退回时填写原因或标记问题卡片，平台将原稿和返修意见交回原标注员。审核或返修提交成功后，页面自动返回工作台。管理后台「审核与返修」显示当前负责人、下一步和历次结果。

标注页支持批量核对。场景道具页一次显示一个分类，「批量核对当前分类」只处理当前显示分类的待核卡片。「人物与对白」的分段步骤使用「批量核对本段」，沿用原工具的播放进度检查。疑问、阻塞问题和需重查卡片仍需逐项处理。

## 关键机制

- **数据切片**：分配的最小单位是（批次 × 任务 × 集）。标注员从「我的任务」打开标注页时，服务端从 `primary.jsonl` 中**只筛出分配给该人的集**，由标注页自动载入。同一账号再次打开同一份作业时，会继续该浏览器里保存的草稿。
- **中文剧集的场景道具依据**：新批次导入时，本机 Ollama 自动把「每段出现」里的英文场景与道具依据翻译成简体中文。发给标注员的场景道具任务使用译文，原始文件保留。没有英文依据的批次可直接导入。需要翻译时，请保持本机 Ollama 运行，默认模型为 `qwen2.5vl:3b`，可用 `ANNOTATION_TRANSLATION_MODEL` 指定已安装的模型。译文不完整时后台会提示，批次可修复后重试。
- **结果回传**：标注页直接提交本集结果 JSON 和工作记录 CSV。服务端校验结果非空、剧集已经完成、任务匹配且属于当前作业。通过后保存文件，并将提交的分配标记为「已提交」。
- **进度**：按任务统计分配、提交和总量。复核结论和当前负责人在「复核与返修」查看。

## 批量操作

- 派单按剧名和语言筛选，可全选筛选结果或勾选部分剧集，再一起分配给所选任务的人员。
- 已有分配支持多选并修改优先级。批量移除只适用于未提交的任务。
- 「审核与返修」支持批量指派作业，审核人逐集填写结论。
- 「交付进度」按剧集汇总四类任务，支持筛选状态、查看处理人和历史结果。管理员可设置每集必须通过的任务。保存交付范围前，页面按批次已分配的任务预估可交付集数。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` / `logout` | 登录 / 登出（Cookie 会话） |
| GET | `/api/auth/me` | 当前用户 |
| GET/POST/DELETE | `/api/admin/users` | 账号管理 |
| GET/POST | `/api/admin/incoming`、`/api/admin/batches/import` | 列目录、导入批次 |
| GET | `/api/admin/batches`、`/batches/:id/items`、`/batches/:id/progress` | 批次与进度 |
| GET/POST | `/api/admin/assignments` | 列出分配，或用 `batchId`、`itemIds`、`allocations: [{ task, assigneeId, reviewerId }]` 批量新增 |
| DELETE | `/api/admin/assignments/:id` | 移除尚未提交的分配 |
| GET | `/api/admin/results`、`/results/:id/download` | 结果与下载 |
| GET | `/api/annotator/jobs` | 我的作业分组 |
| GET | `/api/annotator/data?batchId&task&mode` | 为标注页载入分配的剧集 |
| POST | `/api/annotator/results` | 回传结果并创建复核待办 |
| GET | `/api/reviews` | 管理员查看复核队列，作业人员查看自己的待办 |
| GET/POST | `/api/reviews/:id/work` | 打开和提交本轮复核或返修结果 |
| POST | `/api/reviews/:id/reviewer` | 管理员指派复核人 |
| GET | `/api/reviews/:id/history` | 查看各轮结果 |

## 已知边界与后续方向

- **草稿存于当前浏览器**：未提交的修改自动存入 IndexedDB，需要用同一浏览器打开作业继续。提交后结果存于平台。
- **批次导入**：管理员从 `data/incoming/` 读取批次目录。
- **安全加固**：当前为本地/内网级别（HttpOnly + SameSite 会话、scrypt）。对外部署需加 HTTPS、CSRF 令牌、限流、审计日志。
- **打包回传**：可加一键按 `FS-P001-return/` 目录结构导出压缩包。
