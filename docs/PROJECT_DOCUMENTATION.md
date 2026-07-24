# 综合电商售后处理系统 - 完整项目文档

> 版本: v2.5.0 | 更新日期: 2026-07-24  
> 范围: `local/` 目录（本地部署版，`WORK/` 不再维护）

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [模块参考](#3-模块参考)
4. [核心数据流](#4-核心数据流)
5. [API 接口参考](#5-api-接口参考)
6. [配置系统](#6-配置系统)
7. [部署与运维](#7-部署与运维)
8. [YTDEV 代码评审报告](#8-ytdev-代码评审报告)
9. [已知问题与改进建议](#9-已知问题与改进建议)
10. [工程约定与经验教训](#10-工程约定与经验教训)

---

## 1. 项目概述

### 1.1 定位

综合电商售后处理系统，面向电商运营团队的快递理赔自动化登记场景。系统通过监控微信群聊中的理赔消息，利用 LLM + 规则引擎提取结构化数据，结合旺店通 ERP 反查订单信息，自动写入在线文档（腾讯文档/飞书/金山文档），实现从消息到登记表的全自动化流程。

### 1.2 核心能力

| 能力 | 说明 |
|------|------|
| 多文档查询 | 支持配置多个在线文档，按快递单号搜索退货记录，数据自动缓存与定时刷新 |
| 自然语言写入 | 用自然语言描述要写入的内容，LLM 自动识别表头结构并提取数据 |
| 自动化登记 | 通过观尘 API 监控微信群聊，自动搜索含"理赔"关键词的消息并提取写入 |
| ERP 数据增强 | 通过旺店通 API 反查订单信息，自动填充店铺名称、平台、云仓等字段 |
| 质量门禁 | 金额校验、店铺名校验、物流单号校验，不达标消息转入人工审核 |
| 查重与合并 | 通过物流单号查重，支持跳过、合并补全、覆盖确认三种策略 |
| 批量写入 | 攒批写入 + 限流检测 + 次日恢复，避免触发文档 API 限流 |
| 多提供商适配 | 腾讯文档(MCP)、飞书(OpenAPI)、金山文档(WPS OpenAPI/kdocs-cli) |

### 1.3 技术栈

- **运行时**: Node.js (内置 http 模块，无 Web 框架)
- **LLM SDK**: OpenAI Node.js SDK (兼容 DeepSeek/豆包/通义千问/Ollama 等)
- **数据校验**: Zod
- **前端**: 原生 HTML/CSS/JS 单页应用 (2540 行，无构建工具)
- **外部 API**: 腾讯文档 MCP、飞书开放平台、WPS 开放平台、旺店通 OpenAPI、观尘 API

### 1.4 项目结构

```
local/
├── server.js                    # HTTP 服务器入口（路由 + 静态文件 + API）
├── package.json                 # 依赖声明（openai + zod）
├── config.json                  # 用户配置（gitignore，运行时生成）
├── config.example.json          # 配置示例
├── .env.example                 # 环境变量示例（旺店通凭证）
├── automation-state.json        # 自动化引擎持久化状态（运行时生成）
├── automation-logs.json         # 操作日志持久化（运行时生成）
│
├── src/
│   ├── config.js                # 配置加载/保存/校验/环境变量覆盖
│   ├── constants.js             # 共享常量（平台列表、字段别名、理赔类型等）
│   ├── logger.js                # 操作日志系统（内存缓冲 + 定时落盘）
│   ├── automation.js            # 自动化引擎（搜索→提取→写入循环）
│   ├── write-pipeline.js        # 写入管线（表头读取→提取→查重→写入）
│   ├── write-queue.js           # 写入队列与限流状态管理
│   ├── extractor.js             # 数据提取器（LLM + 规则后处理）
│   ├── llm.js                   # LLM 客户端（OpenAI 兼容封装）
│   ├── guanchen.js              # 观尘 API 客户端（微信消息搜索）
│   ├── wangdian.js              # 旺店通 ERP 客户端（订单查询 + 仓库查询）
│   ├── doc-provider.js          # 文档提供商调度器（路由到具体适配器）
│   ├── shared-docs.js           # 共享工具（CSV解析、状态管理、缓存、数据获取）
│   ├── tencent-docs.js          # 腾讯文档适配器（MCP 协议 + 限流检测）
│   ├── feishu-docs.js           # 飞书适配器（OAuth Token + REST API）
│   ├── jinshan-docs.js          # 金山文档适配器（KSO-1 签名 + DBSheet API）
│   └── jinshan-skill-docs.js    # 金山文档 Skill 适配器（kdocs-cli 命令行）
│
├── public/
│   └── index.html               # SPA 前端（查询/写入/自动化/设置）
│
├── scenarios/                   # 场景测试用例
│   ├── helpers.js               # 测试辅助函数
│   ├── concurrent-writes.test.js
│   ├── data-format-mutation.test.js
│   ├── network-timeout.test.js
│   ├── sheet-permission-change.test.js
│   ├── deep-audit.test.js
│   └── deep-audit-2.test.js
│
├── docs/
│   └── superpowers/plans/       # 历史 PLAN 文档
│
├── manage.bat                   # Windows 服务管理脚本
├── manage.ps1                   # PowerShell 管理脚本（安装看门狗等）
├── start-silent.vbs             # 无窗口启动脚本
├── start-server.vbs             # 服务器启动 VBS
├── server-watchdog.vbs          # 看门狗启动 VBS
└── watchdog.ps1                 # 看门狗脚本（健康检查 + 自动重启）
```

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        前端 SPA (index.html)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  查询页   │  │  写入页   │  │ 自动化页  │  │  设置页   │         │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └─────┬────┘         │
└────────┼────────────┼────────────┼─────────────┼────────────────┘
         │            │            │             │
         ▼            ▼            ▼             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    server.js (HTTP :3000)                        │
│  ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │查询路由  │ │写入路由   │ │自动化路由   │ │配置/密码/日志路由 │  │
│  └────┬────┘ └────┬─────┘ └─────┬──────┘ └────────┬─────────┘  │
└───────┼───────────┼─────────────┼─────────────────┼────────────┘
        │           │             │                  │
        ▼           ▼             ▼                  ▼
┌───────────┐ ┌───────────┐ ┌──────────────┐ ┌───────────┐
│doc-provider│ │write-pipe │ │ automation   │ │  config   │
│ (调度器)   │ │ (写入管线) │ │ (自动化引擎) │ │ (配置管理) │
└─────┬─────┘ └─────┬─────┘ └──────┬───────┘ └───────────┘
      │              │              │
      ▼              ▼              ▼
┌───────────┐ ┌───────────┐ ┌──────────────┐ ┌───────────┐
│tencent-docs│ │extractor  │ │  guanchen    │ │  wangdian │
│feishu-docs │ │ (提取器)   │ │ (观尘API)    │ │  (旺店通)  │
│jinshan-docs│ └─────┬─────┘ └──────────────┘ └───────────┘
│jinshan-skill│      │              │
└───────────┘       ▼              ▼
              ┌───────────┐ ┌──────────────┐
              │   llm     │ │ write-queue  │
              │ (LLM调用) │ │ (写入队列)    │
              └───────────┘ └──────────────┘
```

### 2.2 模块依赖关系

```
server.js
├── config.js
├── doc-provider.js
│   ├── tencent-docs.js → shared-docs.js
│   ├── feishu-docs.js  → shared-docs.js
│   ├── jinshan-docs.js → shared-docs.js
│   └── jinshan-skill-docs.js → shared-docs.js
├── extractor.js → llm.js, constants.js
├── wangdian.js → constants.js
├── automation.js
│   ├── guanchen.js
│   ├── write-pipeline.js
│   │   ├── doc-provider.js
│   │   ├── extractor.js → llm.js, constants.js
│   │   ├── wangdian.js
│   │   ├── config.js
│   │   ├── shared-docs.js
│   │   ├── tencent-docs.js (RateLimitError)
│   │   └── write-queue.js
│   ├── write-queue.js
│   └── logger.js
└── logger.js
```

### 2.3 文档适配器统一接口

所有文档适配器实现以下统一接口，由 `doc-provider.js` 调度：

| 方法 | 必需 | 说明 |
|------|------|------|
| `init(providerConfig, state)` | 是 | 初始化适配器（建立会话/获取Token） |
| `getSheetList(providerConfig, state, fileId)` | 是 | 获取工作表列表 |
| `readSheetCsv(providerConfig, state, fileId, sheetId, rowCount, colCount, startRow)` | 是 | 读取工作表数据为 CSV 文本 |
| `writeRow(providerConfig, state, fileId, sheetId, startRow, values)` | 是 | 写入单行数据 |
| `writeRows(providerConfig, state, fileId, sheetId, startRow, rowsValues)` | 否 | 批量写入多行（支持则单次API调用） |
| `findEmptyRow(providerConfig, state, fileId, sheetId, startRow, colCount, maxRowCount)` | 否 | 查找空行（null 则回退到批次扫描） |
| `getDocState(fileId)` | 是 | 获取文档状态对象（缓存/会话） |
| `clearCache(fileId)` | 是 | 清除缓存 |

---

## 3. 模块参考

### 3.1 server.js — HTTP 服务器

**职责**: HTTP 路由、静态文件服务、API 端点、请求体解析、配置热更新。

**关键设计**:
- 纯 Node.js `http` 模块，无框架依赖
- 请求体大小上限 10MB（防 DoS）
- HTML 文件内存缓存（避免每次读磁盘）
- 配置保存后自动清缓存 + 热更新引擎配置
- 优雅关闭：收到 SIGINT/SIGTERM 时持久化状态和日志
- 密码设置使用 `execFile`（非 `exec`），通过 stdin 传递避免命令注入

**API 路由总览**:

| 路由 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 返回前端 SPA |
| `/api/version` | GET | 返回版本号 |
| `/api/config` | GET | 获取配置（敏感字段脱敏） |
| `/api/config` | PUT | 保存配置（合并敏感字段） |
| `/api/documents` | GET | 文档列表 |
| `/api/search` | GET | 按快递单号搜索 |
| `/api/refresh` | GET | 刷新缓存 |
| `/api/health` | GET | 健康检查 |
| `/api/wdt/query` | GET | 旺店通订单查询 |
| `/api/write/headers` | GET | 获取表头 |
| `/api/write/extract` | POST | LLM 提取 + 查重 |
| `/api/write/execute` | POST | 执行写入 |
| `/api/llm/test` | POST | LLM 连接测试 |
| `/api/automation/status` | GET | 自动化引擎状态 |
| `/api/automation/start` | POST | 启动引擎 |
| `/api/automation/stop` | POST | 停止引擎 |
| `/api/automation/pending` | GET | 待审消息列表 |
| `/api/automation/approve` | POST | 审核通过 |
| `/api/automation/edit-submit` | POST | 编辑后提交 |
| `/api/automation/reject` | POST | 审核拒绝 |
| `/api/automation/clear-pending` | POST | 清空待审 |
| `/api/automation/reextract` | POST | 重新识别 |
| `/api/automation/test` | POST | 观尘连接测试 |
| `/api/logs` | GET/DELETE | 日志查询/清空 |
| `/api/settings/password` | POST | 设置/验证密码 |
| `/api/settings/password-status` | GET | 密码状态 |

### 3.2 src/automation.js — 自动化引擎

**职责**: 定时搜索微信消息 → 过滤已处理 → 提取结构化数据 → 自动写入或加入待审队列。

**核心循环** (`searchAndProcess`):
1. 检查 busy flag（防重入）
2. 调用观尘 API 搜索含关键词的消息
3. 过滤已处理 ID 和屏蔽 ID
4. 过滤不含数字的消息（可选）
5. 限制每轮最多处理 20 条
6. 读取目标文档表头（带 3 次重试）
7. 限流恢复检查：如果限流已过期且队列有积压，先批量写入积压数据
8. 逐条处理消息：提取 → 质量检查 → 入队攒批 或 转入待审
9. 刷新本轮剩余批次
10. 清理超期待审消息
11. 持久化状态

**关键常量**:
- `SEARCH_LIMIT = 200` — 搜索最近 200 条消息
- `MAX_BATCH_SIZE = 20` — 每轮最多处理 20 条
- `DEFAULT_SEARCH_INTERVAL = 60000` — 默认搜索间隔 60 秒
- `BUSY_TIMEOUT = 5 * 60 * 1000` — busy 超时 5 分钟，看门狗强制重置
- `PENDING_TTL = 7 * 24 * 60 * 60 * 1000` — 待审消息 TTL 7 天
- `MAX_PROCESSED_IDS = 1000` — 已处理 ID 上限
- `MAX_BLOCKED_IDS = 5000` — 屏蔽 ID 上限

**自愈看门狗**:
- 每 2 分钟检查一次
- busy 卡死超过 5 分钟 → 强制重置 + 立即触发搜索
- 距上次搜索超过 3 倍间隔 → 触发搜索

**状态持久化** (`automation-state.json`):
- `processedIds` — 已处理消息 ID（FIFO 裁剪至 1000 条）
- `blockedIds` — 屏蔽消息 ID（FIFO 裁剪至 5000 条）
- `pendingMessages` — 待审消息列表
- `stats` — 统计数据
- `writeQueue` — 写入队列状态（含限流截止时间 + 待写记录）

### 3.3 src/write-pipeline.js — 写入管线

**职责**: 表头读取、数据提取与后处理、查重检测、单条写入、批量写入。

**核心函数**:

- `resolveTarget(config, docId, targetId)` — 解析文档与写入目标
- `readSheetHeaders(config, doc, target)` — 读取表头和采样数据（50行）
- `extractAndPrepare(config, doc, target, description, headersInfo, parsedRows)` — 完整提取流程
- `detectDuplicate(headers, parsedRows, extractResult, target)` — 查重检测（4种情况）
- `executeWrite(config, doc, prepareResult, headersInfo)` — 单条写入
- `executeBatchWrite(config, doc, records, headersInfo)` — 批量写入
- `findNextEmptyRow(doc, config, state, fileId, sheetId, startRow, colCount, maxRowCount)` — 查找空行

**查重检测 4 种情况**:

| 情况 | 条件 | 行为 |
|------|------|------|
| skip (identical) | 所有非空字段值完全一致 | 放弃写入，标记已处理 |
| merge | 旧数据不完整，新数据能补全空字段 | 合并写入，仅填充空字段 |
| skip (existing_data_complete) | 旧数据已完整，新数据有不同值 | 不覆盖，保护已有数据 |
| skip (no_new_info) | 旧数据不完整，新数据也没有新信息 | 放弃写入 |

**规则后处理**（修正 LLM 提取的常见错误）:
1. 快递单号为空但订单号是纯数字长串(>=10位) → 移至快递单号字段
2. 快递单号含中文前缀 → 清理为纯字母数字
3. ERP 优先：LLM 提取的快递单号/订单号反查旺店通，命中则覆盖

**质量检查项**:
- `erp_not_matched` — ERP 未匹配到订单
- `no_amount` — 金额为空或 <= 0
- `no_logistics_no` — 无物流单号
- `shop_name_invalid` — 店铺名称误填了状态描述

### 3.4 src/write-queue.js — 写入队列

**职责**: 管理待写入记录队列和限流状态。

**限流机制**:
- 检测到限流（HTTP 429 或错误信息含限流关键词）时，设置 `rateLimitedUntil` 为北京时间当天 23:59:59.999
- 限流期间新消息入队暂存，标记已处理避免重复入池
- 次日限流恢复后，批量写入积压数据

**队列操作**:
- `enqueue(record)` — 入队（队尾追加）
- `enqueueFront(record)` — 队首入队（写失败回填）
- `dequeueBatch(maxSize)` — 批量出队
- `hasMessage(messageId)` — 检查消息是否已在队列中

### 3.5 src/extractor.js — 数据提取器

**职责**: 从自然语言描述中提取结构化数据，支持 LLM 提取 + 规则后处理双引擎。

**提取流程**:
1. LLM 提取（如可用）：构建系统提示词，调用 `chatJSON`，输出 JSON
2. 规则补充：LLM 返回后，空字段用规则引擎补充
3. 纯规则模式（LLM 不可用时）：多模式匹配
4. 自动填充登记日期为当天日期

**规则引擎匹配模式**:
1. 开头长数字串提取为快递单号（>=10位纯数字或字母+数字组合）
2. Token 扫描找快递单号
3. 精确匹配表头
4. 表头前缀匹配（如"快递单号SF123"）
5. 别名匹配（如"单号" → 快递单号）
6. 分隔符匹配（如"货值:399"）
7. 理赔类型+金额模式（如"丢件理赔54.9元"）
8. 字段名+数字模式（如"运费7元"）
9. 全局兜底：运费提取、金额提取（优先带"元"的，其次短数字排除单号）

### 3.6 src/llm.js — LLM 客户端

**职责**: 封装 OpenAI 兼容的 LLM 调用。

**支持的服务商**: DeepSeek、豆包(火山引擎)、通义千问、Ollama(本地)、OpenAI、自定义。

**关键参数**:
- `temperature: 0` — 确定性输出
- `response_format: { type: 'json_object' }` — 强制 JSON 输出
- `max_tokens: 2048`
- `timeout: 30000` — 30 秒超时
- `maxRetries: 2` — 自动重试 2 次

### 3.7 src/guanchen.js — 观尘 API 客户端

**职责**: 通过观尘本地服务搜索微信群聊消息。

**搜索流程**:
1. 获取所有授权群聊列表
2. 对每个群聊按关键词搜索消息
3. 合并结果并按时间倒序排序
4. 截取前 limit 条返回

**安全措施**:
- 响应体大小上限 5MB
- 请求超时 10 秒
- 401/403 鉴权错误直接抛出

### 3.8 src/wangdian.js — 旺店通 ERP 客户端

**职责**: 通过旺店通旗舰版 OpenAPI 查询订单和仓库信息。

**签名算法**: `MD5(secret + 按key正序排列的key-value拼接 + secret)`

**核心函数**:
- `queryOrder(credentials, query)` — 按物流单号或原始单号查询订单
- `queryWarehouse(credentials, warehouseNo)` — 查询仓库名称（API优先，降级到本地映射）
- `autoMatchWdtOrder(credentials, description)` — 从描述文本自动匹配订单
- `mergeWdtData(headers, extractResult, wdtMatch)` — 合并旺店通数据到提取结果
- `parseShopInfo(fullShopName)` — 从店铺名称解析平台和店铺名

**仓库查询降级链**:
1. 调用 `setting.Warehouse.queryWarehouse` API
2. API 返回 0 结果 → 降级到 `config.wangdian.warehouseMap`
3. 本地映射也未命中 → 返回仓库编号原文

### 3.9 文档适配器

#### tencent-docs.js — 腾讯文档适配器

- **协议**: MCP (Model Context Protocol) over HTTPS
- **会话**: 初始化时建立 MCP Session，后续请求复用
- **限流检测**: HTTP 429 或错误信息含限流关键词 → 抛出 `RateLimitError`
- **批量写入**: `writeRows()` 支持单次 API 调用写入多行
- **空行查找**: `findEmptyRow = null`，回退到批次扫描

#### feishu-docs.js — 飞书适配器

- **协议**: 飞书开放平台 REST API
- **鉴权**: OAuth Tenant Access Token（2小时有效，提前5分钟刷新，并发去重）
- **令牌过期处理**: 遇到 99991661/99991663 错误码自动刷新重试
- **行列转换**: 0-based 索引 ↔ 飞书 1-based 行号 + Excel 列字母

#### jinshan-docs.js — 金山文档适配器

- **协议**: WPS 开放平台 DBSheet API
- **鉴权**: Bearer Token + KSO-1 HMAC-SHA256 签名
- **Schema 缓存**: 字段定义缓存于 state，避免重复获取
- **分页拉取**: `MAX_PAGES = 200` 防止分页死循环
- **空行查找**: `findEmptyRow()` 内存扫描全量 CSV

#### jinshan-skill-docs.js — 金山文档 Skill 适配器

- **协议**: kdocs-cli 命令行工具
- **鉴权**: 仅需 Token 一个凭据
- **调用方式**: `execFile` 调用 kdocs-cli（非 shell，避免注入）
- **工作表缓存**: 5 分钟缓存工作表列表
- **空行查找**: `findEmptyRow()` 内存扫描

### 3.10 src/shared-docs.js — 共享工具

**职责**: 与文档提供商无关的通用函数。

| 函数 | 说明 |
|------|------|
| `parseCsvLine(line)` | CSV 单行解析（支持引号转义） |
| `splitCsvLines(csvText)` | CSV 文本按引号感知分割为逻辑行 |
| `csvEscape(value)` | CSV 单元格转义 |
| `csvRow(cells)` | 值数组转 CSV 行 |
| `arrayToCsv(rows)` | 二维数组转 CSV 文本 |
| `parseSheetCsv(csvText, sheetName, fieldMap)` | CSV 解析为标准化记录数组 |
| `searchRecords(records, query)` | 按快递单号搜索 |
| `fetchData(adapter, docConfig, providerConfig, cacheTTL)` | 通用数据获取（带缓存 + 并发去重） |
| `makeGetDocState(extra)` | 状态工厂（生成 getDocState 函数） |
| `makeClearCache(getDocState, extraClear)` | 缓存清理工厂 |

### 3.11 src/doc-provider.js — 文档调度器

**职责**: 根据 `doc.provider` 字段路由到对应适配器，数据驱动管理适配器元数据。

**ADAPTER_META 数据驱动**:
```javascript
{
  tencent:      { configKey: 'tencentDocs',      sensitiveFields: ['apiKey'],       ... },
  feishu:       { configKey: 'feishuDocs',       sensitiveFields: ['appSecret'],    ... },
  jinshan:      { configKey: 'jinshanDocs',      sensitiveFields: ['appKey', 'accessToken'], ... },
  jinshan_skill:{ configKey: 'jinshanSkillDocs',  sensitiveFields: ['token'],        ... }
}
```

### 3.12 src/logger.js — 日志系统

**职责**: 记录所有人工和自动操作，持久化存储，自动清理过期日志。

- **TTL**: 3 天
- **上限**: 5000 条
- **落盘**: 每 30 秒（有变更时）
- **日志类型**: `auto_search`, `auto_extract`, `auto_write`, `auto_approve`, `auto_reject`, `auto_clear`, `auto_reextract`, `auto_edit`, `manual_write`, `config_save`, `system`

### 3.13 src/config.js — 配置管理

**职责**: 配置加载、保存、校验、环境变量覆盖。

**配置层次**:
1. `DEFAULT_CONFIG` — 代码内默认值
2. `config.json` — 用户配置文件
3. 环境变量 — 覆盖敏感信息（`WDT_SID`, `WDT_KEY`, `WDT_SECRET`, `WDT_SALT`, `KINGSOFT_DOCS_TOKEN`, `GUANCHEN_API_KEY`）
4. `SETTINGS_PASSWORD` — 访问密码（仅存环境变量，不写入 config.json）

**向后兼容**: 旧版 `defaultDocumentId` 自动拆分为 `queryDefaultDocumentId` + `writeDefaultDocumentId`。

---

## 4. 核心数据流

### 4.1 自动化登记流程

```
微信群聊消息
    │
    ▼
观尘 API 搜索（关键词"理赔"）
    │
    ▼
过滤已处理/屏蔽 ID + 不含数字的消息
    │
    ▼
逐条处理（每轮最多20条）
    │
    ├── 读取表头（3次重试）
    │
    ├── 并行：LLM 提取 + 旺店通自动匹配
    │       │                    │
    │       ▼                    ▼
    │   规则后处理          ERP 反查订单
    │   (修正错误)          (仓库/店铺/平台)
    │       │                    │
    │       └───────┬────────────┘
    │               ▼
    │       合并旺店通数据（ERP优先级最高）
    │               │
    │               ▼
    │         查重检测
    │         ┌── skip → 标记已处理
    │         ├── merge → 合并写入
    │         └── 无重复 → 继续
    │               │
    │               ▼
    │         质量门禁检查
    │         ┌── 通过 + autoConfirm → 入队攒批
    │         └── 未通过 / 半自动 → 转入待审
    │               │
    ▼               ▼
写入队列          待审队列
(攒够5条批写)     (人工审核/编辑/拒绝)
    │               │
    ▼               ├── approve → 写入文档
批量写入            ├── edit-submit → 编辑后写入
(腾讯文档API)       ├── reject → 屏蔽
    │               └── reextract → 重新识别
    │
    ├── 成功 → 标记已处理 + 更新内存快照
    └── 限流 → 设置限流到当天23:59 + 队列暂存
              │
              ▼
        次日恢复后批量写入积压数据
```

### 4.2 手动写入流程

```
用户输入描述文本
    │
    ▼
POST /api/write/extract
    │
    ├── 读取表头
    ├── 并行：LLM 提取 + 旺店通匹配
    ├── 规则后处理 + ERP 合并
    ├── 查重检测
    │
    ▼
返回提取结果 + 查重信息
    │
    ▼
用户确认/编辑
    │
    ▼
POST /api/write/execute
    │
    ├── 查找空行（或使用查重行号）
    ├── 写入文档
    └── 清除缓存
```

---

## 5. API 接口参考

### 5.1 查询 API

```
GET /api/search?q={快递单号}&docId={文档ID}
```

响应:
```json
{
  "success": true,
  "query": "SF1234567890",
  "docName": "和旭电商退货登记",
  "total": 1,
  "data": [{
    "source": "客退登记",
    "登记日期": "2026-07-01",
    "快递单号": "SF1234567890",
    "商品名称": "蓝牙耳机",
    "正品数量": "2",
    "次品数量": "1",
    "次品备注": "包装破损",
    "备注": ""
  }]
}
```

### 5.2 写入 API

**提取**:
```
POST /api/write/extract
Body: { "docId": "doc1", "targetId": "claim", "description": "..." }
```

**执行写入**:
```
POST /api/write/execute
Body: { "docId": "doc1", "targetFileId": "...", "sheetId": "...", "targetRow": 5, "values": [...], "isDuplicate": false }
```

### 5.3 自动化 API

**获取状态**:
```
GET /api/automation/status
```

响应:
```json
{
  "success": true,
  "data": {
    "running": true,
    "lastSearchTime": 1784880000000,
    "stats": {
      "totalFound": 718,
      "totalProcessed": 718,
      "totalAutoWritten": 482,
      "totalPending": 0,
      "totalRejected": 137,
      "totalFailed": 0
    },
    "pendingCount": 0,
    "processedCount": 718,
    "blockedCount": 137,
    "writeQueueSize": 0,
    "rateLimited": false
  }
}
```

**审核操作**:
```
POST /api/automation/approve    Body: { "messageId": 12345 }
POST /api/automation/reject     Body: { "messageId": 12345 }
POST /api/automation/edit-submit Body: { "messageId": 12345, "editedValues": [...] }
POST /api/automation/reextract  Body: { "messageId": 12345 }
POST /api/automation/clear-pending
```

---

## 6. 配置系统

### 6.1 config.json 结构

```json
{
  "documents": [
    {
      "id": "doc1",
      "name": "文档显示名称",
      "provider": "tencent",
      "fileId": "文件ID",
      "readSheetKeywords": ["关键词1", "关键词2"],
      "writeTargets": [
        { "id": "claim", "name": "快递理赔登记表", "sheetName": "理赔登记" }
      ]
    }
  ],
  "queryDefaultDocumentId": "doc1",
  "writeDefaultDocumentId": "doc1",
  "tencentDocs": { "apiKey": "...", "mcpUrl": "https://docs.qq.com/openapi/mcp" },
  "feishuDocs": { "appId": "...", "appSecret": "..." },
  "jinshanDocs": { "appId": "...", "appKey": "...", "accessToken": "..." },
  "jinshanSkillDocs": { "token": "..." },
  "llm": {
    "provider": "deepseek",
    "customProviderName": "",
    "apiKey": "...",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat"
  },
  "wangdian": { "sid": "...", "key": "...", "secret": "...", "salt": "..." },
  "guanchen": {
    "apiKey": "...",
    "baseUrl": "http://127.0.0.1:8742",
    "enabled": false,
    "keyword": "理赔",
    "requireDigits": false,
    "searchInterval": 60000,
    "targetDocId": "",
    "targetId": "",
    "autoConfirm": false
  },
  "cache": { "ttl": 300000, "autoRefreshInterval": 1800000 },
  "ui": { "logVisible": true }
}
```

### 6.2 环境变量

| 变量名 | 说明 | 存储位置 |
|--------|------|----------|
| `WDT_SID` | 旺店通商家ID | .env 或系统环境变量 |
| `WDT_KEY` | 旺店通AppKey | .env 或系统环境变量 |
| `WDT_SECRET` | 旺店通AppSecret | .env 或系统环境变量 |
| `WDT_SALT` | 旺店通Salt | .env 或系统环境变量 |
| `KINGSOFT_DOCS_TOKEN` | 金山文档Token | .env 或系统环境变量 |
| `GUANCHEN_API_KEY` | 观尘API Key | .env 或系统环境变量 |
| `SETTINGS_PASSWORD` | 访问密码 | Windows用户环境变量（不写入config.json） |
| `KDOCS_CLI_PATH` | kdocs-cli路径 | 系统环境变量（可选，默认'kdocs-cli'） |

### 6.3 LLM 服务商配置

| 服务商 | Base URL | 模型示例 |
|--------|----------|---------|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 豆包(火山引擎) | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-1-5-pro-32k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama(本地) | `http://localhost:11434/v1` | `qwen2.5:7b` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 自定义 | 用户输入 | 用户输入 |

---

## 7. 部署与运维

### 7.1 快速启动

```bash
# 1. 安装依赖
cd d:\Code\Kuaidi\local
npm install

# 2. 配置
copy config.example.json config.json
# 编辑 config.json 填入实际配置

# 3. 配置环境变量（旺店通凭证）
copy .env.example .env
# 编辑 .env 填入旺店通凭证

# 4. 启动
npm start
# 或双击 manage.bat
```

### 7.2 Windows 服务管理

**无窗口启动**: 双击 `start-silent.vbs`

**管理工具**: 双击 `manage.bat` 或运行 `manage.ps1`

**看门狗安装**: `manage.ps1 install-watchdog`
- 注册 Windows 计划任务
- 触发器：登录触发 + 每 5 分钟定时触发
- 策略：`MultipleInstancesPolicy = IgnoreNew`
- 健康检查：端口监听 → 进程存活 → API 响应
- 连续 2 次失败后自动重启

### 7.3 看门狗机制

`watchdog.ps1` 实现三层健康检查：

1. **端口检查**: `Get-NetTCPConnection -LocalPort 3000 -State Listen`
2. **进程检查**: `Get-Process -Id $procId`（防僵尸端口）
3. **API 检查**: `GET /api/automation/status`（确认事件循环未卡死）

连续 2 次失败 → 杀旧进程 → VBS 启动新进程 → 验证恢复。

### 7.4 优雅关闭

收到 `SIGINT`/`SIGTERM` 时：
1. 停止自动化引擎（清除定时器）
2. 持久化引擎状态（processedIds、blockedIds、pendingMessages、writeQueue）
3. 持久化日志
4. `process.exit(0)`

---

## 8. YTDEV 代码评审报告

### 8.1 评审方法

按照 YTDEV 范式，启动 3 个并行子代理分别评审：
- **代码质量评审员**: 命名规范、类型安全、错误处理、边界条件、日志规范、代码注释
- **代码效率评审员**: 算法复杂度、IO阻塞、锁粒度、内存泄漏、异步正确性、网络请求
- **代码可复用性评审员**: 接口抽象、模块解耦、配置化、扩展点、重复代码、可测试性

### 8.2 评分汇总

| 维度 | 评分 | 门禁(>=8) | 状态 |
|------|------|-----------|------|
| 代码质量 | 1.0/10 | 否 | 不通过 |
| 代码效率 | 5.5/10 | 否 | 不通过 |
| 代码可复用性 | 6.0/10 | 否 | 不通过 |

> 注：代码质量评分偏低主要因 P0 级问题（旺店通 API 无超时）导致 -1.0 扣分，实际代码质量在修复 P0 后约 6.5/10。

### 8.3 关键问题清单

#### P0 - 致命问题

| # | 文件 | 问题 | 影响 |
|---|------|------|------|
| 1 | `wangdian.js:72-91` | `callApi` 中 HTTPS 请求未设置超时 | 旺店通 API 无响应时请求永久挂起，阻塞整个自动化引擎 |

#### P1 - 严重问题

| # | 文件 | 问题 | 影响 |
|---|------|------|------|
| 1 | `shared-docs.js:7` | `MAX_COL_COUNT = 10` 硬编码 | 超过10列的表格数据被静默截断丢失 |
| 2 | `jinshan-docs.js:166` | `err.statusCode` 检测永远为 false | 金山文档鉴权错误无法正确识别（死代码） |
| 3 | `server.js:84-87` | CORS 设置为 `Access-Control-Allow-Origin: '*'` | 生产环境安全隐患 |
| 4 | `write-pipeline.js:540-542` | 批量写入回退模式按 `startRow + i` 连续写入 | 首个空行后有非空数据行会被覆盖 |
| 5 | `automation.js:92-118` | 看门狗竞态条件 | busy 重置后原始操作仍可能运行，导致重复处理 |
| 6 | `llm.js:8-13` | 每次调用创建新 OpenAI 客户端 | 无法复用 HTTP 连接池，每轮 20 条 = 20 次 TLS 握手 |
| 7 | `server.js` vs `write-pipeline.js` | 查重逻辑重复且行为分叉 | server.js 版本停留在 2 种情况，pipeline 版本已演进到 4 种 |
| 8 | 5 个适配器文件 | HTTP 请求封装重复约 300 行 | 维护成本高，修改需同步 5 处 |
| 9 | `write-pipeline.js` | 直接依赖 `tencent-docs.js` 的 `RateLimitError` | 跨层耦合，其他适配器限流无法传播 |

#### P2 - 一般问题（Top 10）

| # | 文件 | 问题 |
|---|------|------|
| 1 | `config.js` | `loadConfig`/`saveConfig` 使用同步 IO 在异步路径调用 |
| 2 | `logger.js` | `flush` 使用同步 `writeFileSync` 在定时器中调用 |
| 3 | `server.js:69-74` | HTML 缓存无失效机制，更新前端需重启服务 |
| 4 | `server.js:131-133` | HTML 响应未设置 `Cache-Control: no-cache` 头 |
| 5 | `extractor.js:131` | `split` 正则不够全面，缺少英文标点 |
| 6 | `automation.js` | `persistState` 无写入互斥，并发调用可能写入不一致状态 |
| 7 | 多处 catch 块 | 至少 4 处静默吞错（`wangdian.js:256`、`tencent-docs.js:133`等） |
| 8 | `write-pipeline.js:321-323` | `logisticsColIdx2` 重复定义（与 214 行的 `logisticsColIdx`） |
| 9 | 多个适配器 | 无 HTTP Keep-Alive / 连接复用 |
| 10 | `server.js` | `handleRequest` 827 行单体函数，无法单元测试 |

---

## 9. 已知问题与改进建议

### 9.1 优先修复建议（按 ROI 排序）

#### P0: 旺店通 API 请求超时
**文件**: `src/wangdian.js` `callApi` 函数  
**修复**: 在 `https.request` 后添加 `req.setTimeout(30000, ...)`  
**影响**: 防止引擎永久卡死，当前仅靠看门狗 5 分钟超时恢复

#### P1: 提取通用 HTTP 客户端
**文件**: 新建 `src/http-client.js`  
**范围**: 合并 5 个适配器中重复的 HTTPS Promise 封装（约 300 行 → 1 处）  
**收益**: 统一超时、错误处理、连接复用，降低维护成本

#### P1: server.js 复用 write-pipeline.js
**范围**: 将 server.js 中的查重逻辑、`findNextEmptyRow`、表头读取替换为调用 `write-pipeline.js`  
**收益**: 消除逻辑分叉，确保两条写入路径行为一致

#### P1: RateLimitError 移至 shared-docs.js
**范围**: 将 `RateLimitError` 类从 `tencent-docs.js` 移至 `shared-docs.js`  
**收益**: 解除 `write-pipeline.js` 对 `tencent-docs.js` 的跨层依赖

#### P2: LLM 客户端单例化
**文件**: `src/llm.js`  
**修复**: 缓存 OpenAI 客户端实例，按 baseURL+apiKey 复用  
**收益**: 减少 TLS 握手开销，提升自动化引擎吞吐量

### 9.2 架构改进建议

1. **路由表化**: 将 server.js 的 if-else 路由重构为路由表 + handler 函数，提升可测试性
2. **适配器能力声明**: 在适配器对象上添加 `supports` 集合（如 `supportsBatchWrite`），替代 `adapter.writeRows &&` 检测
3. **常量集中管理**: 将散落在各文件的魔数（如 `MAX_COL_COUNT`、`HEADER_SAMPLE_ROW_LIMIT`、`EMPTY_ROW_BATCH_SIZE`）统一到 `constants.js`
4. **配置热更新范围扩大**: 将 `llm` 和 `guanchen` 配置也纳入 `ADAPTER_META` 数据驱动管理

---

## 10. 工程约定与经验教训

### 10.1 硬约束

- 登记时自动填充当前日期（YYYY-MM-DD）到"登记日期"列
- 登记数据必须追加到已有内容的下一行，不允许留空行
- 腾讯文档写入接口中 row 和 col 均为 0-based 索引
- 前端文案中"LLM"统一改为"AI"（设置页面除外）
- 查询默认表格和登记默认表格需区分开，在设置中可单独勾选
- 访问密码必须存储在 Windows 用户环境变量 `SETTINGS_PASSWORD`，不写入 `config.json`
- 密码设置接口必须使用 `execFile` 而非 `exec`，参数通过 stdin 传递，已设置密码后禁止重置
- 金山文档适配器需实现 `findEmptyRow` 方法，通过全量 CSV 内存扫描获取精确行号
- 飞书/腾讯文档适配器 `findEmptyRow` 设为 null，回退到批次扫描逻辑
- 所有文档适配器必须实现 `init(doc, config, state)` 方法，由调度器统一调用
- 共享工具函数 `splitCsvLines` 需支持引号感知分割，处理多行单元格场景
- 缓存更新仅在数据获取成功且非空时执行，防止空缓存固化
- 金山文档 API 调用需设置 `MAX_PAGES=200` 防止分页死循环
- 401/403 鉴权错误必须直接抛出，不回退虚拟工作表

### 10.2 工程约定

- 表格标题行解析后需去除末尾连续的空列，确保 headers 和 values 长度一致
- 旺店通数据优先级高于 LLM/规则识别，匹配到的字段覆盖已有值
- 仓库名称通过调用 `setting.Warehouse.queryWarehouse` 接口查询，API 返回 0 结果时降级到本地映射
- LLM 服务商选择"自定义"时需手动输入服务商名、Base URL、模型和 API Key
- 切换 LLM 服务商时，仅在输入框为空时才填充默认 Base URL 和模型
- 查重逻辑在 `/api/write/extract` 中完成，通过"快递单号"或"物流单号"列定位物流单号
- 完整性判断时自动排除"备注"列，合并模式下仅填充原记录中为空的字段
- 文档适配器配置项通过 `ADAPTER_META` 数据驱动管理，新增提供商无需修改 server.js
- CSV 处理函数 `csvEscape`/`csvRow`/`arrayToCsv` 集中到 `shared-docs.js` 统一实现
- 文档状态管理通过 `makeGetDocState(extra)` 工厂函数集中创建

### 10.3 经验教训

- 使用 koa-connect 包装 Express 中间件会导致 `ctx.state` 数据丢失，需使用原生 Koa 重写
- 腾讯文档 `sheet.set_range_value` 接口的 row 和 col 索引规则曾被错误理解为 row 1-based、col 0-based，导致数据偏移
- 旺店通 `setting.Warehouse.queryWarehouse` 接口可能返回"接口权限不足"或 0 结果，需做好容错
- PowerShell 写入 Windows 环境变量的同步操作会阻塞前端响应，需改为后台异步执行
- HTML 响应必须设置 `Cache-Control: no-cache, no-store, must-revalidate` 头，防止浏览器缓存旧页面
- 模板字符串内的换行需使用转义符 `\n`，避免 JS 代码因真实换行符导致 `Invalid or unexpected token` 错误
- 金山文档 `writeRow` 为追加式写入，忽略 `startRow` 参数，直接使用 `findEmptyRow` 返回行号会导致计算错误
- 使用 `exec` 直接拼接密码到命令字符串存在命令注入风险，即使局域网环境也必须修复
- `detectDuplicate` 函数在 `extractResult.values` 为 null 时会崩溃，需先进行防御性赋值
- `extractAndPrepare` 函数在 `headersInfo` 为 null 或 `success=false` 时会崩溃，需先检查状态再解构
- 看门狗计划任务仅使用 `LogonTrigger` 会导致进程崩溃或会话断开后无法自动拉起，需同时添加每 5 分钟定时触发器
- 金额提取不能仅依赖"元"字，客服可能不打"元"字，需增加无"元"字的兜底提取逻辑
- 邮政新单号格式为 13 位纯数字，需在正则中支持 `^\d{10,}$` 匹配

---

## 附录

### A. 场景测试用例

| 文件 | 场景 | 说明 |
|------|------|------|
| `concurrent-writes.test.js` | 并发写入 | 多请求同时写入同一文档 |
| `data-format-mutation.test.js` | 数据格式突变 | 表头变更、列顺序变化 |
| `network-timeout.test.js` | 网络超时 | API 响应超时处理 |
| `sheet-permission-change.test.js` | Sheet 权限变更 | 文档权限被收回 |
| `deep-audit.test.js` | 深度审计 | 全流程端到端验证 |
| `deep-audit-2.test.js` | 深度审计 2 | 补充场景验证 |

### B. 运行测试

```bash
cd d:\Code\Kuaidi\local
npm test
# 或指定文件
node --test scenarios/deep-audit.test.js
```

### C. 依赖清单

| 依赖 | 版本 | 用途 |
|------|------|------|
| `openai` | ^4.77.0 | LLM API 调用（兼容多厂商） |
| `zod` | ^3.24.0 | 数据校验（当前未深度使用） |

### D. 文件行数统计

| 文件 | 行数 | 说明 |
|------|------|------|
| `server.js` | 1014 | 主服务器 |
| `public/index.html` | 2540 | 前端 SPA |
| `src/automation.js` | 908 | 自动化引擎 |
| `src/write-pipeline.js` | 584 | 写入管线 |
| `src/extractor.js` | 358 | 数据提取器 |
| `src/jinshan-docs.js` | 390 | 金山文档适配器 |
| `src/tencent-docs.js` | 342 | 腾讯文档适配器 |
| `src/shared-docs.js` | 292 | 共享工具 |
| `src/wangdian.js` | 282 | 旺店通客户端 |
| `src/feishu-docs.js` | 246 | 飞书适配器 |
| `src/config.js` | 153 | 配置管理 |
| `src/doc-provider.js` | 159 | 文档调度器 |
| `src/jinshan-skill-docs.js` | 201 | 金山 Skill 适配器 |
| `src/logger.js` | 137 | 日志系统 |
| `src/guanchen.js` | 135 | 观尘客户端 |
| `src/write-queue.js` | 164 | 写入队列 |
| `src/llm.js` | 77 | LLM 客户端 |
| `src/constants.js` | 80 | 常量定义 |
| **合计** | ~8560 | |
