# 综合电商售后处理系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有的单文档只读退货查询系统，升级为可配置、可复用、可读、可写的综合电商售后处理系统，支持多文档切换查询、LLM 辅助自然语言写入。

**Architecture:** Node.js 原生 HTTP 服务（不引入 Express），后端模块化拆分为 config / tencent-docs / llm / extractor 四个模块。前端改为单页应用（SPA），通过 Tab 切换"查询 / 写入 / 设置"三个视图。配置通过 `config.json` 文件持久化，运行时可通过设置页面修改。LLM 集成采用 OpenAI 兼容 SDK，通过切换 baseURL/apiKey/model 支持云端（DeepSeek/豆包/通义千问）和本地（Ollama）。

**Tech Stack:** Node.js (内置 http 模块)、OpenAI SDK (npm `openai`)、Zod (schema 校验)、腾讯文档 MCP API、原生 HTML/CSS/JS 前端

---

## 文件结构

```
d:\Code\Kuaidi\
├── package.json                 # 新建：npm 依赖声明
├── config.json                  # 新建：用户配置（gitignore）
├── config.example.json          # 新建：配置示例（可提交）
├── .gitignore                   # 新建：忽略敏感文件
├── server.js                    # 修改：重构为入口，调用 src/ 模块
├── src/
│   ├── config.js                # 新建：配置加载/保存
│   ├── tencent-docs.js          # 新建：MCP 客户端（读+写）
│   ├── llm.js                   # 新建：LLM 客户端工厂
│   └── extractor.js             # 新建：自然语言→结构化数据提取
├── public/
│   └── index.html               # 修改：SPA，含查询/写入/设置三个视图
├── manage.bat                   # 保留不动
├── start-silent.vbs             # 保留不动
└── docs/
    └── superpowers/
        └── plans/
            └── 2026-06-22-ecommerce-after-sales-system.md  # 本文件
```

**各文件职责：**
- `src/config.js` — 加载/保存 `config.json`，提供默认值合并、配置校验
- `src/tencent-docs.js` — 封装 MCP API 调用（initialize / tools/call），提供 `getSheetList` / `readSheetCsv` / `writeRow` 等方法，支持多文档
- `src/llm.js` — LLM 客户端工厂，根据 config 中的 provider/apiKey/baseUrl/model 创建 OpenAI 兼容客户端
- `src/extractor.js` — 动态结构化数据提取：接收表头数组 + 用户自然语言，调用 LLM 返回字段映射 JSON
- `server.js` — HTTP 服务器入口，路由分发，调用上述模块
- `public/index.html` — SPA 前端，Tab 切换三个视图

---

## Task 1: 项目初始化 — package.json 与目录结构

**Files:**
- Create: `d:\Code\Kuaidi\package.json`
- Create: `d:\Code\Kuaidi\.gitignore`
- Create: `d:\Code\Kuaidi\src\` (目录)

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "kuaidi-after-sales",
  "version": "2.0.0",
  "description": "综合电商售后处理系统 - 可配置、可复用、可读、可写",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "openai": "^4.77.0",
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 2: 创建 .gitignore**

```
node_modules/
config.json
*.log
.env
```

- [ ] **Step 3: 创建 src 目录**

Run: `mkdir d:\Code\Kuaidi\src`
Expected: 目录创建成功

- [ ] **Step 4: 安装依赖**

Run: `cd d:\Code\Kuaidi && npm install`
Expected: `node_modules/` 目录生成，`openai` 和 `zod` 安装成功

- [ ] **Step 5: 验证依赖可用**

Run: `node -e "const {z}=require('zod'); const {OpenAI}=require('openai'); console.log('deps ok')"`
Expected: 输出 `deps ok`

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: init project with dependencies"
```

---

## Task 2: 配置系统 — config.json 与 config.js

**Files:**
- Create: `d:\Code\Kuaidi\config.example.json`
- Create: `d:\Code\Kuaidi\src\config.js`
- Test: 内联在 `src/config.js` 底部的自测

- [ ] **Step 1: 创建 config.example.json**

```json
{
  "documents": [
    {
      "id": "doc1",
      "name": "和旭电商退货登记",
      "fileId": "YOUR_FILE_ID_HERE",
      "readSheetKeywords": ["客退", "退货"],
      "writeTargets": [
        {
          "id": "claim",
          "name": "快递理赔登记表",
          "sheetName": "理赔登记"
        },
        {
          "id": "exchange",
          "name": "售后换货登记表",
          "sheetName": "换货登记"
        }
      ]
    }
  ],
  "defaultDocumentId": "doc1",
  "tencentDocs": {
    "apiKey": "YOUR_TENCENT_DOCS_API_KEY",
    "mcpUrl": "https://docs.qq.com/openapi/mcp"
  },
  "llm": {
    "provider": "deepseek",
    "apiKey": "YOUR_LLM_API_KEY",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat"
  },
  "cache": {
    "ttl": 300000,
    "autoRefreshInterval": 1800000
  }
}
```

- [ ] **Step 2: 创建 src/config.js — 配置加载与保存模块**

```js
// src/config.js
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');

/** 默认配置（当 config.json 不存在时使用） */
const DEFAULT_CONFIG = {
  documents: [],
  defaultDocumentId: '',
  tencentDocs: {
    apiKey: '',
    mcpUrl: 'https://docs.qq.com/openapi/mcp'
  },
  llm: {
    provider: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  cache: {
    ttl: 300000,
    autoRefreshInterval: 1800000
  }
};

/**
 * 深度合并两个对象（source 覆盖 target）
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * 加载配置：优先读 config.json，不存在则用默认值
 * @returns {object} 合并后的完整配置
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const userConfig = JSON.parse(raw);
      return deepMerge(DEFAULT_CONFIG, userConfig);
    }
  } catch (err) {
    console.error('[config] 加载配置失败:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * 保存配置到 config.json
 * @param {object} config 完整配置对象
 */
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log('[config] 配置已保存');
}

/**
 * 根据 ID 查找文档配置
 * @param {object} config 全局配置
 * @param {string} docId 文档 ID
 * @returns {object|null} 文档配置对象
 */
function getDocumentById(config, docId) {
  return config.documents.find(d => d.id === docId) || null;
}

/**
 * 获取默认文档配置
 * @param {object} config 全局配置
 * @returns {object|null} 默认文档配置
 */
function getDefaultDocument(config) {
  if (config.defaultDocumentId) {
    return getDocumentById(config, config.defaultDocumentId);
  }
  return config.documents[0] || null;
}

/**
 * 校验配置完整性
 * @param {object} config 配置对象
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateConfig(config) {
  const errors = [];
  if (!config.tencentDocs.apiKey) {
    errors.push('腾讯文档 API Key 未配置');
  }
  if (!config.documents || config.documents.length === 0) {
    errors.push('至少需要配置一个文档');
  } else {
    for (const doc of config.documents) {
      if (!doc.fileId) errors.push(`文档"${doc.name}"缺少 fileId`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { loadConfig, saveConfig, getDocumentById, getDefaultDocument, validateConfig, deepMerge, DEFAULT_CONFIG };
```

- [ ] **Step 3: 验证 config.js 可加载**

Run: `node -e "const c=require('./src/config'); const cfg=c.loadConfig(); console.log('docs:', cfg.documents.length, 'llm:', cfg.llm.provider)"`
Expected: 输出 `docs: 0 llm: deepseek`（因为还没有 config.json）

- [ ] **Step 4: 创建 config.json（从 example 复制并填入真实值）**

将 `config.example.json` 复制为 `config.json`，填入真实的 fileId 和 apiKey：
- `documents[0].fileId` = `DV3BSQ2VVaXpqVkNj`（从原 server.js 迁移）
- `tencentDocs.apiKey` = `e307046ff3f64c099f678442a95bb8a5`（从原 server.js 迁移）

- [ ] **Step 5: 验证配置加载正确**

Run: `node -e "const c=require('./src/config'); const cfg=c.loadConfig(); console.log('docs:', cfg.documents.length, 'fileId:', cfg.documents[0].fileId)"`
Expected: 输出 `docs: 1 fileId: DV3BSQ2VVaXpqVkNj`

- [ ] **Step 6: Commit**

```bash
git add config.example.json src/config.js
git commit -m "feat: add config system with multi-document support"
```

---

## Task 3: MCP 客户端模块 — src/tencent-docs.js

**Files:**
- Create: `d:\Code\Kuaidi\src\tencent-docs.js`

将 `server.js` 中的 MCP 调用逻辑提取为独立模块，支持多文档（通过 fileId 参数）。

- [ ] **Step 1: 创建 src/tencent-docs.js**

```js
// src/tencent-docs.js
const https = require('https');

// 每个文档独立维护 session 和缓存
const docStates = new Map(); // fileId -> { mcpSessionId, cachedData, cacheTimestamp, cacheLoading }

function getDocState(fileId) {
  if (!docStates.has(fileId)) {
    docStates.set(fileId, {
      mcpSessionId: null,
      cachedData: null,
      cacheTimestamp: 0,
      cacheLoading: false
    });
  }
  return docStates.get(fileId);
}

/**
 * MCP API 调用
 */
function callMcpApi(mcpUrl, apiKey, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: method,
      params: params
    });

    const url = new URL(mcpUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    if (sessionId) {
      options.headers['Mcp-Session-Id'] = sessionId;
    }

    const req = https.request(options, (res) => {
      const newSessionId = res.headers['mcp-session-id'] || sessionId;
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve({ result: parsed.result, sessionId: newSessionId });
          }
        } catch (e) {
          reject(new Error('解析响应失败: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(new Error('请求失败: ' + e.message)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(body);
    req.end();
  });
}

function sendMcpNotification(mcpUrl, apiKey, method, params, sessionId) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  const url = new URL(mcpUrl);
  const options = {
    hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey, 'Content-Length': Buffer.byteLength(body) }
  };
  if (sessionId) options.headers['Mcp-Session-Id'] = sessionId;
  const req = https.request(options, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

/**
 * 调用 MCP 工具
 */
async function callTool(mcpUrl, apiKey, sessionId, name, args) {
  const { result, sessionId: newSessionId } = await callMcpApi(mcpUrl, apiKey, 'tools/call', { name, arguments: args }, sessionId);
  return { result, sessionId: newSessionId };
}

/**
 * 从工具结果中提取文本
 */
function extractText(toolResult) {
  if (!toolResult || !toolResult.content) return '';
  let text = '';
  for (const c of toolResult.content) {
    if (c.type === 'text') {
      try {
        const inner = JSON.parse(c.text);
        if (inner.csv_data) return inner.csv_data;
        if (inner.content) text += inner.content;
        else text += c.text;
      } catch (e) {
        text += c.text;
      }
    }
  }
  return text;
}

/**
 * 初始化 MCP 连接
 */
async function initMcp(mcpUrl, apiKey, state) {
  if (state.mcpSessionId) return;
  const { sessionId } = await callMcpApi(mcpUrl, apiKey, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kuaidi-after-sales', version: '2.0.0' }
  }, null);
  state.mcpSessionId = sessionId;
  sendMcpNotification(mcpUrl, apiKey, 'notifications/initialized', {}, sessionId);
  await new Promise(r => setTimeout(r, 500));
}

/**
 * 获取所有 sheet 信息
 */
async function getSheetList(mcpUrl, apiKey, state, fileId) {
  const { result, sessionId } = await callTool(mcpUrl, apiKey, state.mcpSessionId, 'sheet.get_sheet_info', { file_id: fileId });
  state.mcpSessionId = sessionId;
  const text = extractText(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed.sheets) return parsed.sheets;
  } catch (e) {}
  return [];
}

/**
 * 读取单个 sheet 的 CSV 数据
 */
async function readSheetCsv(mcpUrl, apiKey, state, fileId, sheetId, rowCount, colCount) {
  const { result, sessionId } = await callTool(mcpUrl, apiKey, state.mcpSessionId, 'sheet.get_cell_data', {
    file_id: fileId,
    sheet_id: sheetId,
    start_row: 0,
    end_row: rowCount,
    start_col: 0,
    end_col: Math.min(colCount, 10),
    return_csv: true
  });
  state.mcpSessionId = sessionId;
  return extractText(result);
}

/**
 * 解析 CSV 行
 */
function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * 解析单个 sheet 的 CSV 数据为记录数组
 */
function parseSheetCsv(csvText, sheetName) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headerCells = parseCsvLine(lines[0]);

  const trackingIdx = headerCells.findIndex(h => h.includes('快递单号') || h.includes('单号'));
  if (trackingIdx === -1) return [];

  const dateIdx = headerCells.findIndex(h => h.includes('登记日期') || h.includes('日期'));
  const productIdx = headerCells.findIndex(h => h.includes('商品名称') || h.includes('货品'));
  const genuineIdx = headerCells.findIndex(h => h.includes('正品'));
  const defectIdx = headerCells.findIndex(h => h.includes('次品') || h.includes('残品'));
  const defectNoteIdx = headerCells.findIndex(h => h.includes('次品备注') || h.includes('残品备注'));
  const remarkIdx = headerCells.findIndex(h => h === '备注');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const trackingNo = (cells[trackingIdx] || '').trim();
    if (!trackingNo) continue;

    records.push({
      _source: sheetName,
      '登记日期': dateIdx >= 0 ? (cells[dateIdx] || '').trim() : '',
      '快递单号': trackingNo,
      '商品名称': productIdx >= 0 ? (cells[productIdx] || '').trim() : '',
      '正品数量': genuineIdx >= 0 ? (cells[genuineIdx] || '').trim() : '',
      '次品数量': defectIdx >= 0 ? (cells[defectIdx] || '').trim() : '',
      '次品备注': defectNoteIdx >= 0 ? (cells[defectNoteIdx] || '').trim() : '',
      '备注': remarkIdx >= 0 ? (cells[remarkIdx] || '').trim() : ''
    });
  }

  return records;
}

/**
 * 获取指定文档的所有退货数据（带缓存）
 * @param {object} docConfig 文档配置 { fileId, readSheetKeywords }
 * @param {object} tencentDocsConfig { apiKey, mcpUrl }
 * @param {number} cacheTTL 缓存有效期（毫秒）
 * @returns {Promise<Array>} 记录数组
 */
async function fetchData(docConfig, tencentDocsConfig, cacheTTL) {
  const state = getDocState(docConfig.fileId);
  const now = Date.now();

  if (state.cachedData && (now - state.cacheTimestamp) < cacheTTL) {
    return state.cachedData;
  }

  if (state.cacheLoading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!state.cacheLoading) { clearInterval(check); resolve(state.cachedData); }
      }, 200);
    });
  }

  state.cacheLoading = true;
  try {
    await initMcp(tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state);
    const sheets = await getSheetList(tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state, docConfig.fileId);

    const keywords = docConfig.readSheetKeywords || ['客退', '退货'];
    const allRecords = [];

    for (const sheet of sheets) {
      const isDataSheet = keywords.some(kw => sheet.sheet_name.includes(kw));
      if (!isDataSheet) continue;

      try {
        const csv = await readSheetCsv(tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state, docConfig.fileId, sheet.sheet_id, sheet.row_count, sheet.col_count);
        const records = parseSheetCsv(csv, sheet.sheet_name);
        allRecords.push(...records);
      } catch (err) {
        console.error(`    读取失败 [${sheet.sheet_name}]: ${err.message}`);
      }
    }

    state.cachedData = allRecords;
    state.cacheTimestamp = now;
    return allRecords;
  } catch (err) {
    if (state.cachedData) return state.cachedData;
    throw err;
  } finally {
    state.cacheLoading = false;
  }
}

/**
 * 搜索记录
 */
function searchRecords(records, query) {
  if (!query || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  return records.filter(r => (r['快递单号'] || '').toLowerCase().includes(q));
}

/**
 * 清除指定文档的缓存
 */
function clearCache(fileId) {
  const state = getDocState(fileId);
  state.cachedData = null;
  state.cacheTimestamp = 0;
  state.mcpSessionId = null;
}

module.exports = {
  getSheetList,
  readSheetCsv,
  readSheetHeaders: readSheetCsv, // 别名，读取表头用同样的方法
  parseCsvLine,
  parseSheetCsv,
  fetchData,
  searchRecords,
  clearCache,
  initMcp,
  callTool,
  extractText,
  getDocState
};
```

- [ ] **Step 2: 验证模块可加载**

Run: `node -e "const t=require('./src/tencent-docs'); console.log(typeof t.fetchData, typeof t.searchRecords)"`
Expected: 输出 `function function`

- [ ] **Step 3: Commit**

```bash
git add src/tencent-docs.js
git commit -m "feat: extract MCP client to tencent-docs.js with multi-document support"
```

---

## Task 4: MCP 写入工具发现 — 调用 tools/list 获取写入工具 Schema

**Files:**
- Create: `d:\Code\Kuaidi\src\discover-tools.js`（临时脚本，用完可删）

腾讯文档 MCP 的 `batch_update_sheet_range` 工具官方文档未说明如何指定 sheet 和起始行，需要调用 `tools/list` 获取完整 Schema。

- [ ] **Step 1: 创建发现脚本**

```js
// src/discover-tools.js
const { loadConfig } = require('./config');
const https = require('https');

const config = loadConfig();

function callMcpApi(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now().toString(), method, params });
    const url = new URL(config.tencentDocs.mcpUrl);
    const options = {
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': config.tencentDocs.apiKey, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  // 1. initialize
  const initResp = await callMcpApi('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'discover', version: '1.0' }
  });
  console.log('Session:', initResp.result);

  // 2. tools/list
  const listResp = await callMcpApi('tools/list', {});
  if (listResp.result && listResp.result.tools) {
    for (const tool of listResp.result.tools) {
      console.log('\n===', tool.name, '===');
      console.log('Description:', tool.description);
      console.log('Schema:', JSON.stringify(tool.inputSchema, null, 2));
    }
  }
}

main().catch(console.error);
```

- [ ] **Step 2: 运行发现脚本**

Run: `node src/discover-tools.js`
Expected: 输出所有可用工具的名称、描述和 inputSchema。**重点记录 `batch_update_sheet_range` 的完整参数结构**，特别是是否有 `sheet_id`、`start_row`、`start_col` 等参数。

- [ ] **Step 3: 根据发现结果更新 tencent-docs.js 的写入函数**

根据 `tools/list` 返回的实际 Schema，在 `src/tencent-docs.js` 中添加 `writeRow` 函数。以下为两种可能的实现（根据实际 Schema 选择）：

**情况 A：如果 batch_update_sheet_range 支持 sheet_id 和起始坐标参数：**

```js
/**
 * 向指定 sheet 写入一行数据
 * @param {object} tencentDocsConfig { apiKey, mcpUrl }
 * @param {string} fileId 文档 ID
 * @param {string} sheetId 工作表 ID
 * @param {number} startRow 起始行（0-based）
 * @param {string[]} values 要写入的值数组
 * @returns {Promise<{updateNum: number}>}
 */
async function writeRow(tencentDocsConfig, fileId, sheetId, startRow, values) {
  const state = getDocState(fileId);
  await initMcp(tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state);

  const args = {
    file_id: fileId,
    sheet_id: sheetId,
    start_row: startRow,
    start_col: 0,
    texts: {
      rows: [{ values: values.map(String) }]
    }
  };

  const { result, sessionId } = await callTool(
    tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state.mcpSessionId,
    'batch_update_sheet_range', args
  );
  state.mcpSessionId = sessionId;

  const text = extractText(result);
  try {
    const parsed = JSON.parse(text);
    return { updateNum: parsed.update_num || 0 };
  } catch (e) {
    return { updateNum: 0 };
  }
}
```

**情况 B：如果 batch_update_sheet_range 仅支持 file_id 和 texts（无 sheet_id）：**

需要通过先读取 sheet 列表确认默认 sheet，或通过其他方式定位。在此情况下，`writeRow` 签名调整为只传 `fileId` 和 `values`，并需在文档中说明写入的是默认 sheet。

> **重要：实际实现时，请根据 Step 2 的输出结果选择正确的参数结构。将 `writeRow` 函数添加到 `src/tencent-docs.js` 的 `module.exports` 之前，并在 `module.exports` 中导出。**

- [ ] **Step 4: 验证 writeRow 函数存在**

Run: `node -e "const t=require('./src/tencent-docs'); console.log(typeof t.writeRow)"`
Expected: 输出 `function`

- [ ] **Step 5: 删除发现脚本**

Run: `del d:\Code\Kuaidi\src\discover-tools.js`

- [ ] **Step 6: Commit**

```bash
git add src/tencent-docs.js
git commit -m "feat: add writeRow function based on MCP tool schema discovery"
```

---

## Task 5: LLM 客户端模块 — src/llm.js

**Files:**
- Create: `d:\Code\Kuaidi\src\llm.js`

- [ ] **Step 1: 创建 src/llm.js**

```js
// src/llm.js
const OpenAI = require('openai');

/**
 * 根据 config 创建 LLM 客户端
 * @param {object} llmConfig { provider, apiKey, baseUrl, model }
 * @returns {{ client: OpenAI, model: string, provider: string }}
 */
function createLLMClient(llmConfig) {
  if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
    throw new Error(`LLM API Key 未配置 (provider: ${llmConfig.provider})`);
  }

  const client = new OpenAI({
    apiKey: llmConfig.apiKey || 'ollama',
    baseURL: llmConfig.baseUrl,
    timeout: 30000,
    maxRetries: 2
  });

  return {
    client,
    model: llmConfig.model,
    provider: llmConfig.provider
  };
}

/**
 * 调用 LLM 获取 JSON 格式响应
 * @param {object} llmConfig LLM 配置
 * @param {string} systemPrompt 系统提示词
 * @param {string} userMessage 用户消息
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
async function chatJSON(llmConfig, systemPrompt, userMessage) {
  const { client, model } = createLLMClient(llmConfig);

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 2048
  });

  const content = completion.choices[0].message.content;

  if (!content || !content.trim()) {
    throw new Error('LLM 返回空内容，请重试');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('LLM 输出无法解析为 JSON: ' + content.substring(0, 200));
    }
  }

  return parsed;
}

/**
 * 测试 LLM 连接是否正常
 * @param {object} llmConfig LLM 配置
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testConnection(llmConfig) {
  try {
    const { client, model } = createLLMClient(llmConfig);
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: '请回复"ok"' }],
      max_tokens: 10,
      temperature: 0
    });
    const text = completion.choices[0].message.content;
    return { ok: true, message: `连接成功，模型回复: ${text}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { createLLMClient, chatJSON, testConnection };
```

- [ ] **Step 2: 验证模块可加载**

Run: `node -e "const l=require('./src/llm'); console.log(typeof l.createLLMClient, typeof l.chatJSON)"`
Expected: 输出 `function function`

- [ ] **Step 3: Commit**

```bash
git add src/llm.js
git commit -m "feat: add LLM client module with OpenAI-compatible multi-provider support"
```

---

## Task 6: 动态数据提取器 — src/extractor.js

**Files:**
- Create: `d:\Code\Kuaidi\src\extractor.js**

核心模块：接收表头数组 + 用户自然语言描述，调用 LLM 动态提取每个表头对应的值。不硬编码字段 schema，适配任意表格结构。

- [ ] **Step 1: 创建 src/extractor.js**

```js
// src/extractor.js
const { chatJSON } = require('./llm');

/**
 * 构建系统提示词
 * @param {string[]} headers 表头数组
 * @param {string} tableName 表格名称
 * @returns {string} 系统提示词
 */
function buildSystemPrompt(headers, tableName) {
  return `你是一个电商售后数据录入助手。
用户要向"${tableName}"写入一条新记录。
表格的列标题如下：
${JSON.stringify(headers)}

请从用户的自然语言描述中，提取每个列标题对应的值，以 JSON 格式输出。

【输出规则】
1. 只输出 JSON，不要输出任何解释、markdown 标记或多余文字。
2. JSON 的 key 必须与上面的列标题完全一致。
3. 如果某个列的值无法从描述中提取，对应值填空字符串 ""。
4. 不要编造未提及的信息。
5. 金额字段只填数字，不带"元"字。
6. 日期字段格式为 YYYY-MM-DD。

【示例】
列标题：["登记日期","店铺名称","平台","订单号","快递单号","理赔类型","货值","运费","备注"]
用户输入：华强北数码3C店 淘宝 订单号123456789 快递单号SF1234567890 丢件登记理赔货值399元 运费20元
输出：{"登记日期":"","店铺名称":"华强北数码3C店","平台":"淘宝","订单号":"123456789","快递单号":"SF1234567890","理赔类型":"丢件","货值":"399","运费":"20","备注":""}`;
}

/**
 * 从自然语言提取表格行数据
 * @param {object} llmConfig LLM 配置
 * @param {string[]} headers 表头数组
 * @param {string} tableName 表格名称
 * @param {string} userDescription 用户自然语言描述
 * @returns {Promise<{values: string[], missing: string[], raw: object}>}
 */
async function extractRowData(llmConfig, headers, tableName, userDescription) {
  const systemPrompt = buildSystemPrompt(headers, tableName);

  const raw = await chatJSON(llmConfig, systemPrompt, userDescription);

  // 将 JSON 对象按表头顺序映射为数组
  const values = headers.map(h => {
    const v = raw[h];
    if (v === undefined || v === null) return '';
    return String(v);
  });

  // 找出缺失的字段
  const missing = headers.filter(h => !raw[h] || String(raw[h]).trim() === '');

  return { values, missing, raw };
}

/**
 * 生成写入预览文本
 * @param {string[]} headers 表头数组
 * @param {string[]} values 值数组
 * @returns {string} 预览文本
 */
function buildPreviewText(headers, values) {
  const lines = [];
  for (let i = 0; i < headers.length; i++) {
    const val = values[i] || '(空)';
    lines.push(`  ${headers[i]}: ${val}`);
  }
  return lines.join('\n');
}

module.exports = { extractRowData, buildPreviewText, buildSystemPrompt };
```

- [ ] **Step 2: 验证模块可加载**

Run: `node -e "const e=require('./src/extractor'); console.log(typeof e.extractRowData, typeof e.buildPreviewText)"`
Expected: 输出 `function function`

- [ ] **Step 3: Commit**

```bash
git add src/extractor.js
git commit -m "feat: add dynamic data extractor for natural language to table row mapping"
```

---

## Task 7: 服务器重构 — server.js 整合所有模块

**Files:**
- Modify: `d:\Code\Kuaidi\server.js`（完全重写）

将原 `server.js` 重构为入口文件，调用 `src/` 下的模块，新增配置管理、多文档查询、写入等 API 路由。

- [ ] **Step 1: 重写 server.js**

```js
/**
 * 综合电商售后处理系统 - 后端服务 v2
 * 可配置、可复用、可读、可写
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { loadConfig, saveConfig, getDocumentById, getDefaultDocument, validateConfig } = require('./src/config');
const tencentDocs = require('./src/tencent-docs');
const { testConnection: testLLMConnection } = require('./src/llm');
const { extractRowData, buildPreviewText } = require('./src/extractor');

const PORT = 3000;
const HOST = '0.0.0.0';

let config = loadConfig();

// ============================================================
// 工具函数
// ============================================================

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// ============================================================
// API 路由
// ============================================================

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- 静态文件 ---
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  // --- 配置 API ---
  if (url.pathname === '/api/config' && req.method === 'GET') {
    // 返回配置（隐藏 API Key 的中间部分）
    const safeConfig = JSON.parse(JSON.stringify(config));
    if (safeConfig.tencentDocs.apiKey) {
      const k = safeConfig.tencentDocs.apiKey;
      safeConfig.tencentDocs.apiKey = k.substring(0, 4) + '****' + k.substring(k.length - 4);
    }
    if (safeConfig.llm.apiKey) {
      const k = safeConfig.llm.apiKey;
      safeConfig.llm.apiKey = k.substring(0, 4) + '****' + k.substring(k.length - 4);
    }
    sendJSON(res, 200, { success: true, data: safeConfig });
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      // 合并新配置（保留原有的 apiKey 如果新值为空或包含 ****）
      const newConfig = { ...config };
      newConfig.documents = body.documents || config.documents;
      newConfig.defaultDocumentId = body.defaultDocumentId || config.defaultDocumentId;
      newConfig.cache = body.cache || config.cache;

      if (body.tencentDocs) {
        newConfig.tencentDocs = {
          apiKey: (body.tencentDocs.apiKey && !body.tencentDocs.apiKey.includes('****'))
            ? body.tencentDocs.apiKey : config.tencentDocs.apiKey,
          mcpUrl: body.tencentDocs.mcpUrl || config.tencentDocs.mcpUrl
        };
      }

      if (body.llm) {
        newConfig.llm = {
          provider: body.llm.provider || config.llm.provider,
          apiKey: (body.llm.apiKey && !body.llm.apiKey.includes('****'))
            ? body.llm.apiKey : config.llm.apiKey,
          baseUrl: body.llm.baseUrl || config.llm.baseUrl,
          model: body.llm.model || config.llm.model
        };
      }

      saveConfig(newConfig);
      config = loadConfig();
      // 清除所有缓存
      for (const doc of config.documents) {
        tencentDocs.clearCache(doc.fileId);
      }
      sendJSON(res, 200, { success: true, message: '配置已保存' });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- 文档列表 API ---
  if (url.pathname === '/api/documents' && req.method === 'GET') {
    const docs = config.documents.map(d => ({
      id: d.id,
      name: d.name,
      isDefault: d.id === config.defaultDocumentId,
      writeTargetCount: (d.writeTargets || []).length
    }));
    sendJSON(res, 200, { success: true, data: docs });
    return;
  }

  // --- 查询 API（支持多文档） ---
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const docId = url.searchParams.get('docId') || config.defaultDocumentId;

    const doc = getDocumentById(config, docId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    try {
      const records = await tencentDocs.fetchData(doc, config.tencentDocs, config.cache.ttl);
      const results = tencentDocs.searchRecords(records, query);
      sendJSON(res, 200, {
        success: true,
        query,
        docName: doc.name,
        total: results.length,
        data: results.map(r => ({
          source: r._source,
          登记日期: r['登记日期'] || '',
          快递单号: r['快递单号'] || '',
          商品名称: r['商品名称'] || '',
          正品数量: r['正品数量'] || '',
          次品数量: r['次品数量'] || '',
          次品备注: r['次品备注'] || '',
          备注: r['备注'] || ''
        }))
      });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- 刷新缓存 API ---
  if (url.pathname === '/api/refresh' && req.method === 'GET') {
    const docId = url.searchParams.get('docId') || config.defaultDocumentId;
    const doc = getDocumentById(config, docId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }
    try {
      tencentDocs.clearCache(doc.fileId);
      const records = await tencentDocs.fetchData(doc, config.tencentDocs, config.cache.ttl);
      sendJSON(res, 200, { success: true, message: '数据刷新成功', total: records.length });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- 健康检查 ---
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJSON(res, 200, { status: 'ok', documents: config.documents.length });
    return;
  }

  // --- 写入：获取表头 ---
  if (url.pathname === '/api/write/headers' && req.method === 'GET') {
    const docId = url.searchParams.get('docId') || config.defaultDocumentId;
    const targetId = url.searchParams.get('targetId');

    const doc = getDocumentById(config, docId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    const target = (doc.writeTargets || []).find(t => t.id === targetId);
    if (!target) {
      sendJSON(res, 400, { success: false, error: '未找到指定的写入目标表格' });
      return;
    }

    try {
      const state = tencentDocs.getDocState(doc.fileId);
      await tencentDocs.initMcp(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state);
      const sheets = await tencentDocs.getSheetList(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state, doc.fileId);

      // 通过 sheetName 匹配
      const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];
      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '文档中未找到任何工作表' });
        return;
      }

      const csv = await tencentDocs.readSheetCsv(
        config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state,
        doc.fileId, sheet.sheet_id, Math.min(sheet.row_count, 50), sheet.col_count
      );

      // 解析表头（第一行）
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length === 0) {
        sendJSON(res, 400, { success: false, error: '工作表为空' });
        return;
      }
      const headers = tencentDocs.parseCsvLine(lines[0]);

      // 同时返回当前已有数据行数（用于找空行）
      sendJSON(res, 200, {
        success: true,
        data: {
          headers,
          sheetName: sheet.sheet_name,
          sheetId: sheet.sheet_id,
          rowCount: sheet.row_count,
          colCount: sheet.col_count,
          existingDataLines: lines.length - 1
        }
      });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- 写入：LLM 提取 ---
  if (url.pathname === '/api/write/extract' && req.method === 'POST') {
    const body = await readBody(req);
    const { docId, targetId, description } = body;

    const doc = getDocumentById(config, docId || config.defaultDocumentId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    const target = (doc.writeTargets || []).find(t => t.id === targetId);
    if (!target) {
      sendJSON(res, 400, { success: false, error: '未找到指定的写入目标表格' });
      return;
    }

    if (!description || !description.trim()) {
      sendJSON(res, 400, { success: false, error: '请输入描述内容' });
      return;
    }

    try {
      // 1. 获取表头
      const state = tencentDocs.getDocState(doc.fileId);
      await tencentDocs.initMcp(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state);
      const sheets = await tencentDocs.getSheetList(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state, doc.fileId);
      const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];

      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '文档中未找到任何工作表' });
        return;
      }

      const csv = await tencentDocs.readSheetCsv(
        config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state,
        doc.fileId, sheet.sheet_id, Math.min(sheet.row_count, 50), sheet.col_count
      );

      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length === 0) {
        sendJSON(res, 400, { success: false, error: '工作表为空' });
        return;
      }
      const headers = tencentDocs.parseCsvLine(lines[0]);

      // 2. 调用 LLM 提取结构化数据
      const { values, missing } = await extractRowData(config.llm, headers, target.name, description);

      // 3. 查找空行位置
      // 读取已有数据，找到第一个空行
      let emptyRowIndex = lines.length; // 默认在最后一行之后
      for (let i = 1; i < lines.length; i++) {
        const cells = tencentDocs.parseCsvLine(lines[i]);
        const isEmpty = cells.every(c => !c || !c.trim());
        if (isEmpty) {
          emptyRowIndex = i;
          break;
        }
      }

      // 4. 返回预览数据
      sendJSON(res, 200, {
        success: true,
        data: {
          headers,
          values,
          missing,
          targetRow: emptyRowIndex,
          sheetName: sheet.sheet_name,
          sheetId: sheet.sheet_id,
          preview: buildPreviewText(headers, values)
        }
      });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- 写入：执行写入 ---
  if (url.pathname === '/api/write/execute' && req.method === 'POST') {
    const body = await readBody(req);
    const { docId, sheetId, targetRow, values } = body;

    const doc = getDocumentById(config, docId || config.defaultDocumentId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    if (!values || !Array.isArray(values)) {
      sendJSON(res, 400, { success: false, error: '写入数据无效' });
      return;
    }

    try {
      // 再次检查目标行是否为空（防止并发写入）
      const state = tencentDocs.getDocState(doc.fileId);
      const sheets = await tencentDocs.getSheetList(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state, doc.fileId);
      const sheet = sheets.find(s => s.sheet_id === sheetId);
      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '未找到指定工作表' });
        return;
      }

      // 读取目标行检查是否为空
      const checkCsv = await tencentDocs.readSheetCsv(
        config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state,
        doc.fileId, sheetId, targetRow + 1, sheet.col_count
      );
      const checkLines = checkCsv.split('\n').filter(l => l.trim());
      if (checkLines.length > targetRow + 1) {
        // 检查目标行是否已有数据
        const rowCells = tencentDocs.parseCsvLine(checkLines[targetRow + 1] || '');
        const hasData = rowCells.some(c => c && c.trim());
        if (hasData) {
          sendJSON(res, 409, { success: false, error: '目标行已有数据，可能正在被其他人使用，请重新提取' });
          return;
        }
      }

      // 执行写入
      const result = await tencentDocs.writeRow(
        config.tencentDocs, doc.fileId, sheetId, targetRow, values
      );

      // 清除缓存
      tencentDocs.clearCache(doc.fileId);

      sendJSON(res, 200, {
        success: true,
        message: `写入成功，更新了 ${result.updateNum} 个单元格`,
        data: { updateNum: result.updateNum, row: targetRow }
      });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- LLM 连接测试 ---
  if (url.pathname === '/api/llm/test' && req.method === 'POST') {
    const body = await readBody(req);
    const llmConfig = body.llmConfig || config.llm;
    try {
      const result = await testLLMConnection(llmConfig);
      sendJSON(res, 200, { success: result.ok, message: result.message });
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

// ============================================================
// 启动服务器
// ============================================================

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, async () => {
  const nets = require('os').networkInterfaces();
  let lanIp = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && net.address !== '127.0.0.1') {
        lanIp = net.address;
        break;
      }
    }
    if (lanIp) break;
  }

  console.log('========================================');
  console.log('  综合电商售后处理系统 v2');
  console.log(`  本机访问: http://localhost:${PORT}`);
  if (lanIp) console.log(`  局域网访问: http://${lanIp}:${PORT}`);
  console.log(`  已配置文档: ${config.documents.length} 个`);
  console.log(`  LLM 提供商: ${config.llm.provider}`);
  console.log('========================================');

  // 校验配置
  const { valid, errors } = validateConfig(config);
  if (!valid) {
    console.log('\n⚠ 配置不完整:');
    errors.forEach(e => console.log('  - ' + e));
    console.log('  请访问 http://localhost:' + PORT + ' 的"设置"页面完善配置');
  }

  // 定时自动刷新数据
  if (config.cache.autoRefreshInterval > 0) {
    setInterval(async () => {
      for (const doc of config.documents) {
        try {
          tencentDocs.clearCache(doc.fileId);
          const records = await tencentDocs.fetchData(doc, config.tencentDocs, config.cache.ttl);
          console.log(`[自动刷新] ${doc.name} — ${records.length} 条记录`);
        } catch (err) {
          console.error(`[自动刷新] ${doc.name} 失败: ${err.message}`);
        }
      }
    }, config.cache.autoRefreshInterval);
  }
});
```

- [ ] **Step 2: 验证服务器可启动**

Run: `node -e "require('./server.js')" &` (后台启动，然后访问测试)
然后访问: `http://localhost:3000/api/health`
Expected: 返回 `{"status":"ok","documents":1}`

- [ ] **Step 3: 验证配置 API**

访问: `http://localhost:3000/api/config`
Expected: 返回配置 JSON（API Key 已脱敏）

- [ ] **Step 4: 验证文档列表 API**

访问: `http://localhost:3000/api/documents`
Expected: 返回 `{"success":true,"data":[{"id":"doc1","name":"和旭电商退货登记","isDefault":true,"writeTargetCount":2}]}`

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: refactor server.js with modular architecture, multi-document read, write API, config API"
```

---

## Task 8: 前端 SPA 框架 — 导航与视图切换

**Files:**
- Modify: `d:\Code\Kuaidi\public\index.html`（完全重写）

将单页查询界面重构为 SPA，包含三个 Tab 视图：查询、写入、设置。

- [ ] **Step 1: 重写 public/index.html — HTML 结构与 CSS**

将 `public/index.html` 完全重写。以下为 HTML 结构和 CSS 部分（`<style>` 标签内容）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>综合电商售后处理系统</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0A0F1A;
      --bg-secondary: #111827;
      --bg-card: #151C2C;
      --bg-hover: #1A2332;
      --text-primary: #E2E8F0;
      --text-secondary: #8892B0;
      --text-muted: #4A5568;
      --accent: #00D4AA;
      --accent-dim: rgba(0, 212, 170, 0.1);
      --accent-glow: rgba(0, 212, 170, 0.25);
      --border: #1E293B;
      --border-accent: rgba(0, 212, 170, 0.3);
      --danger: #F87171;
      --danger-bg: rgba(248, 113, 113, 0.08);
      --warning-bg: rgba(251, 191, 36, 0.12);
      --warning-text: #FBBF24;
      --font-display: 'Space Grotesk', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
      --radius: 8px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-display);
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    .app {
      max-width: 1120px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }

    /* ── Header ── */
    .header { margin-bottom: 32px; }

    .header-top {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }

    .header-tag {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      color: var(--accent);
      background: var(--accent-dim);
      border: 1px solid var(--border-accent);
      padding: 3px 10px;
      border-radius: 4px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .header h1 {
      font-size: clamp(24px, 4vw, 36px);
      font-weight: 700;
      letter-spacing: -0.5px;
      line-height: 1.2;
    }

    .header-sub {
      font-size: 15px;
      color: var(--text-secondary);
      margin-top: 6px;
    }

    /* ── Tabs ── */
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0;
    }

    .tab {
      padding: 10px 20px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      font-family: var(--font-display);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
      margin-bottom: -1px;
    }

    .tab:hover { color: var(--text-primary); }
    .tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    /* ── Views ── */
    .view { display: none; }
    .view.active { display: block; }

    /* ── Card ── */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 28px;
      margin-bottom: 20px;
    }

    .card-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 16px;
    }

    /* ── Form Elements ── */
    .form-group { margin-bottom: 16px; }

    label {
      display: block;
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 6px;
      font-weight: 500;
    }

    input[type="text"],
    input[type="password"],
    input[type="url"],
    select,
    textarea {
      width: 100%;
      padding: 10px 14px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: var(--font-display);
      font-size: 14px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    input:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }

    select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892B0' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 36px;
    }

    textarea {
      min-height: 80px;
      resize: vertical;
      font-family: var(--font-mono);
    }

    .btn {
      padding: 10px 24px;
      border: none;
      border-radius: 6px;
      font-family: var(--font-display);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
      white-space: nowrap;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--bg-primary);
    }

    .btn-secondary {
      background: var(--bg-hover);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }

    .btn-danger {
      background: var(--danger);
      color: #fff;
    }

    .btn:hover { opacity: 0.88; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    /* ── Search specific ── */
    .search-row {
      display: flex;
      gap: 10px;
      align-items: stretch;
    }

    .search-input-wrap {
      flex: 1;
      position: relative;
    }

    .search-prefix {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-muted);
      pointer-events: none;
    }

    .search-input {
      width: 100%;
      padding: 13px 16px 13px 36px;
      font-family: var(--font-mono);
      font-size: 15px;
    }

    .doc-selector {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }

    .doc-selector select {
      width: 240px;
    }

    .search-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 14px;
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .btn-refresh {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-refresh:hover { border-color: var(--accent); color: var(--accent); }

    /* ── Status Messages ── */
    .error-box {
      display: none;
      background: var(--danger-bg);
      border: 1px solid rgba(248, 113, 113, 0.2);
      border-radius: 6px;
      padding: 14px 20px;
      color: var(--danger);
      font-size: 14px;
      margin-bottom: 20px;
    }
    .error-box.visible { display: block; }

    .success-box {
      display: none;
      background: var(--accent-dim);
      border: 1px solid var(--border-accent);
      border-radius: 6px;
      padding: 14px 20px;
      color: var(--accent);
      font-size: 14px;
      margin-bottom: 20px;
    }
    .success-box.visible { display: block; }

    /* ── Loading ── */
    .loading { display: none; text-align: center; padding: 48px 20px; }
    .loading.visible { display: block; }

    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .loading p {
      margin-top: 14px;
      color: var(--text-secondary);
      font-size: 13px;
      font-family: var(--font-mono);
    }

    /* ── Table ── */
    .table-scroll { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      padding: 11px 20px;
      text-align: left;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      background: var(--bg-secondary);
    }

    tbody td {
      padding: 12px 20px;
      font-size: 14px;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }

    tbody tr { transition: background 0.12s; }
    tbody tr:hover { background: var(--bg-hover); }
    tbody tr:last-child td { border-bottom: none; }

    .tag {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid var(--border-accent);
    }

    .hl {
      background: var(--warning-bg);
      color: var(--warning-text);
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 600;
    }

    /* ── Write Preview ── */
    .preview-table {
      width: 100%;
      border-collapse: collapse;
    }

    .preview-table th {
      padding: 8px 14px;
      font-size: 12px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      text-align: left;
    }

    .preview-table td {
      padding: 10px 14px;
      font-size: 14px;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
    }

    .preview-table .empty-cell {
      color: var(--danger);
      font-style: italic;
    }

    .missing-fields {
      background: var(--warning-bg);
      border: 1px solid rgba(251, 191, 36, 0.2);
      border-radius: 6px;
      padding: 12px 16px;
      color: var(--warning-text);
      font-size: 13px;
      margin-bottom: 16px;
    }

    /* ── Settings ── */
    .settings-section {
      margin-bottom: 28px;
    }

    .settings-section h3 {
      font-size: 14px;
      color: var(--accent);
      margin-bottom: 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .doc-list-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
    }

    .doc-list-item .name {
      flex: 1;
      font-weight: 500;
    }

    .doc-list-item .actions {
      display: flex;
      gap: 6px;
    }

    .btn-icon {
      padding: 4px 10px;
      font-size: 12px;
    }

    .form-row {
      display: flex;
      gap: 14px;
    }

    .form-row .form-group {
      flex: 1;
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      .app { padding: 24px 12px 48px; }
      .card { padding: 18px; }
      .search-row { flex-direction: column; }
      .form-row { flex-direction: column; }
      .doc-selector select { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <div class="header-top">
        <span class="header-tag">v2.0</span>
      </div>
      <h1>综合电商售后处理系统</h1>
      <p class="header-sub">查询 · 写入 · 设置 — 数据来源：<code>腾讯文档</code></p>
    </header>

    <!-- Tabs -->
    <nav class="tabs">
      <button class="tab active" data-view="query" onclick="switchView('query')">查询</button>
      <button class="tab" data-view="write" onclick="switchView('write')">写入</button>
      <button class="tab" data-view="settings" onclick="switchView('settings')">设置</button>
    </nav>

    <!-- Query View -->
    <section class="view active" id="view-query">
      <div class="card">
        <div class="doc-selector">
          <label for="queryDocSelect" style="margin:0">文档：</label>
          <select id="queryDocSelect" onchange="onQueryDocChange()"></select>
        </div>
        <div class="search-row">
          <div class="search-input-wrap">
            <span class="search-prefix">&gt;</span>
            <input type="text" class="search-input" id="searchInput" placeholder="输入快递单号..." autocomplete="off" spellcheck="false"/>
          </div>
          <button class="btn btn-primary" id="searchBtn" onclick="doSearch()">查询</button>
        </div>
        <div class="search-meta">
          <span id="statusText">ready</span>
          <button class="btn-refresh" onclick="doRefresh()">刷新数据</button>
        </div>
      </div>

      <div class="error-box" id="errorMsg"></div>
      <div class="loading" id="loading">
        <div class="spinner"></div>
        <p>fetching data...</p>
      </div>

      <div class="card" id="resultPanel" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h2 class="card-title" style="margin:0">查询结果</h2>
          <span style="font-family:var(--font-mono);font-size:13px;color:var(--text-secondary)">共 <em id="totalCount" style="font-style:normal;color:var(--accent);font-weight:600">0</em> 条</span>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>来源</th><th>登记日期</th><th>快递单号</th><th>商品名称</th>
                <th>正品</th><th>次品</th><th>次品备注</th><th>备注</th>
              </tr>
            </thead>
            <tbody id="resultBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Write View -->
    <section class="view" id="view-write">
      <div class="card">
        <h2 class="card-title">写入新记录</h2>
        <div class="form-row">
          <div class="form-group">
            <label>选择文档</label>
            <select id="writeDocSelect" onchange="onWriteDocChange()"></select>
          </div>
          <div class="form-group">
            <label>选择目标表格</label>
            <select id="writeTargetSelect"></select>
          </div>
        </div>
        <div class="form-group">
          <label>用自然语言描述要写入的内容</label>
          <textarea id="writeDescription" placeholder="例如：华强北数码3C店 淘宝 订单号123456789 快递单号SF1234567890 丢件登记理赔货值399元 运费20元"></textarea>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="extractBtn" onclick="doExtract()">提取并预览</button>
        </div>
      </div>

      <div class="error-box" id="writeError"></div>
      <div class="success-box" id="writeSuccess"></div>
      <div class="loading" id="writeLoading">
        <div class="spinner"></div>
        <p>LLM 正在分析...</p>
      </div>

      <div class="card" id="previewPanel" style="display:none">
        <h2 class="card-title">写入预览</h2>
        <div id="missingFields" class="missing-fields" style="display:none"></div>
        <div class="table-scroll">
          <table class="preview-table">
            <thead><tr id="previewHeader"></tr></thead>
            <tbody><tr id="previewRow"></tr></tbody>
          </table>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px">
          <button class="btn btn-primary" onclick="doWrite()">确认写入</button>
          <button class="btn btn-secondary" onclick="cancelWrite()">取消</button>
        </div>
      </div>
    </section>

    <!-- Settings View -->
    <section class="view" id="view-settings">
      <div class="card">
        <h2 class="card-title">系统设置</h2>

        <div class="settings-section">
          <h3>腾讯文档配置</h3>
          <div class="form-group">
            <label>API Key</label>
            <input type="password" id="cfgTencentKey" placeholder="腾讯文档 API Key"/>
          </div>
          <div class="form-group">
            <label>MCP API 地址</label>
            <input type="url" id="cfgTencentUrl" placeholder="https://docs.qq.com/openapi/mcp"/>
          </div>
        </div>

        <div class="settings-section">
          <h3>LLM 配置</h3>
          <div class="form-row">
            <div class="form-group">
              <label>服务商</label>
              <select id="cfgLlmProvider" onchange="onLlmProviderChange()">
                <option value="deepseek">DeepSeek</option>
                <option value="doubao">豆包 (火山引擎)</option>
                <option value="qwen">通义千问</option>
                <option value="ollama">Ollama (本地)</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
            <div class="form-group">
              <label>模型名称</label>
              <input type="text" id="cfgLlmModel" placeholder="deepseek-chat"/>
            </div>
          </div>
          <div class="form-group">
            <label>API Key</label>
            <input type="password" id="cfgLlmKey" placeholder="LLM API Key"/>
          </div>
          <div class="form-group">
            <label>Base URL</label>
            <input type="url" id="cfgLlmUrl" placeholder="https://api.deepseek.com"/>
          </div>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-secondary" onclick="testLLM()">测试连接</button>
          </div>
        </div>

        <div class="settings-section">
          <h3>文档配置</h3>
          <div id="docListContainer"></div>
          <button class="btn btn-secondary" onclick="addDocument()" style="margin-top:8px">+ 添加文档</button>
        </div>

        <div class="settings-section">
          <h3>缓存配置</h3>
          <div class="form-row">
            <div class="form-group">
              <label>缓存有效期（秒）</label>
              <input type="text" id="cfgCacheTtl" placeholder="300"/>
            </div>
            <div class="form-group">
              <label>自动刷新间隔（秒）</label>
              <input type="text" id="cfgCacheRefresh" placeholder="1800"/>
            </div>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" onclick="saveSettings()">保存配置</button>
        </div>
      </div>
    </section>
  </div>

  <script>
    // JS 代码在 Task 9 中添加
  </script>
</body>
</html>
```

- [ ] **Step 2: 验证页面可访问**

启动服务器后访问 `http://localhost:3000/`，确认三个 Tab 可切换，各视图结构正确显示。

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: rebuild frontend as SPA with query/write/settings tabs"
```

---

## Task 9: 前端 JavaScript — 三个视图的交互逻辑

**Files:**
- Modify: `d:\Code\Kuaidi\public\index.html`（替换 `<script>` 标签内容）

- [ ] **Step 1: 替换 index.html 中的 `<script>` 部分**

将 `public/index.html` 中 `<script>` 标签内的内容替换为以下完整 JavaScript：

```javascript
    const $ = id => document.getElementById(id);

    // ============================================================
    // 全局状态
    // ============================================================
    let currentConfig = null;
    let documents = [];
    let writePreviewData = null;

    // ============================================================
    // 通用工具
    // ============================================================
    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function hl(text, q) {
      if (!q) return esc(text);
      const safe = esc(text);
      const sq = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return safe.replace(new RegExp('(' + sq + ')', 'gi'), '<span class="hl">$1</span>');
    }

    function showError(msg, container) {
      const el = container || $('errorMsg');
      el.textContent = msg;
      el.classList.add('visible');
      setTimeout(() => el.classList.remove('visible'), 8000);
    }

    function showSuccess(msg) {
      const el = $('writeSuccess');
      el.textContent = msg;
      el.classList.add('visible');
      setTimeout(() => el.classList.remove('visible'), 8000);
    }

    function setStatus(t) { $('statusText').textContent = t; }

    // ============================================================
    // Tab 切换
    // ============================================================
    function switchView(viewName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelector(`.tab[data-view="${viewName}"]`).classList.add('active');
      $(`view-${viewName}`).classList.add('active');

      if (viewName === 'settings') loadSettings();
      if (viewName === 'query') loadDocSelector('queryDocSelect');
      if (viewName === 'write') loadDocSelector('writeDocSelect');
    }

    // ============================================================
    // 文档选择器
    // ============================================================
    async function loadDocSelector(selectId) {
      try {
        const resp = await fetch('/api/documents');
        const data = await resp.json();
        if (data.success) {
          documents = data.data;
          const sel = $(selectId);
          sel.innerHTML = '';
          documents.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name + (d.isDefault ? ' (默认)' : '');
            if (d.isDefault) opt.selected = true;
            sel.appendChild(opt);
          });

          // 如果是写入视图，加载写入目标
          if (selectId === 'writeDocSelect') {
            onWriteDocChange();
          }
        }
      } catch (err) {
        console.error('加载文档列表失败:', err);
      }
    }

    function onQueryDocChange() {
      setStatus('ready');
    }

    async function onWriteDocChange() {
      const docId = $('writeDocSelect').value;
      const doc = documents.find(d => d.id === docId);
      if (!doc) return;

      // 从配置中获取该文档的写入目标
      try {
        const resp = await fetch('/api/config');
        const data = await resp.json();
        if (data.success) {
          const docConfig = data.data.documents.find(d => d.id === docId);
          const targets = (docConfig && docConfig.writeTargets) || [];
          const sel = $('writeTargetSelect');
          sel.innerHTML = '';
          if (targets.length === 0) {
            sel.innerHTML = '<option value="">未配置写入目标</option>';
          } else {
            targets.forEach(t => {
              const opt = document.createElement('option');
              opt.value = t.id;
              opt.textContent = t.name;
              sel.appendChild(opt);
            });
          }
        }
      } catch (err) {
        console.error('加载写入目标失败:', err);
      }
    }

    // ============================================================
    // 查询功能
    // ============================================================
    $('searchInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') doSearch();
    });

    async function doSearch() {
      const q = $('searchInput').value.trim();
      if (!q) { showError('请输入快递单号'); $('searchInput').focus(); return; }

      const docId = $('queryDocSelect').value;
      $('resultPanel').style.display = 'none';
      $('loading').classList.add('visible');
      $('errorMsg').classList.remove('visible');
      $('searchBtn').disabled = true;
      setStatus('querying...');

      try {
        const resp = await fetch('/api/search?q=' + encodeURIComponent(q) + '&docId=' + encodeURIComponent(docId));
        const data = await resp.json();
        $('loading').classList.remove('visible');

        if (!data.success) {
          showError(data.error || '查询失败');
          setStatus('error');
          return;
        }

        $('totalCount').textContent = data.total;
        const body = $('resultBody');
        body.innerHTML = '';

        if (data.total === 0) {
          body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">未找到匹配记录</td></tr>';
        } else {
          data.data.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML =
              '<td><span class="tag">' + esc(r.source) + '</span></td>' +
              '<td>' + esc(r['登记日期']) + '</td>' +
              '<td style="color:var(--text-primary);font-family:var(--font-mono);font-size:13px">' + hl(r['快递单号'], q) + '</td>' +
              '<td>' + esc(r['商品名称']) + '</td>' +
              '<td>' + esc(r['正品数量']) + '</td>' +
              '<td>' + esc(r['次品数量']) + '</td>' +
              '<td>' + esc(r['次品备注']) + '</td>' +
              '<td>' + esc(r['备注']) + '</td>';
            body.appendChild(tr);
          });
        }

        $('resultPanel').style.display = 'block';
        setStatus('done — ' + data.total + ' result' + (data.total > 1 ? 's' : ''));
      } catch (err) {
        $('loading').classList.remove('visible');
        showError('网络请求失败');
        setStatus('network error');
      } finally {
        $('searchBtn').disabled = false;
      }
    }

    async function doRefresh() {
      const docId = $('queryDocSelect').value;
      setStatus('refreshing...');
      try {
        const resp = await fetch('/api/refresh?docId=' + encodeURIComponent(docId));
        const data = await resp.json();
        if (data.success) {
          setStatus('synced — ' + data.total + ' records');
        } else {
          showError('刷新失败: ' + (data.error || ''));
          setStatus('error');
        }
      } catch {
        setStatus('network error');
      }
    }

    // ============================================================
    // 写入功能
    // ============================================================
    async function doExtract() {
      const docId = $('writeDocSelect').value;
      const targetId = $('writeTargetSelect').value;
      const description = $('writeDescription').value.trim();

      if (!targetId) { showError('请选择目标表格', 'writeError'); return; }
      if (!description) { showError('请输入描述内容', 'writeError'); return; }

      $('previewPanel').style.display = 'none';
      $('writeLoading').classList.add('visible');
      $('writeError').classList.remove('visible');
      $('writeSuccess').classList.remove('visible');
      $('extractBtn').disabled = true;

      try {
        const resp = await fetch('/api/write/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docId, targetId, description })
        });
        const data = await resp.json();
        $('writeLoading').classList.remove('visible');

        if (!data.success) {
          showError(data.error || '提取失败', 'writeError');
          return;
        }

        writePreviewData = data.data;

        // 渲染预览表格
        const headers = data.data.headers;
        const values = data.data.values;

        $('previewHeader').innerHTML = headers.map(h => '<th>' + esc(h) + '</th>').join('');
        $('previewRow').innerHTML = values.map(v => {
          if (!v || !v.trim()) return '<td class="empty-cell">(空)</td>';
          return '<td>' + esc(v) + '</td>';
        }).join('');

        // 显示缺失字段提示
        if (data.data.missing && data.data.missing.length > 0) {
          const el = $('missingFields');
          el.style.display = 'block';
          el.textContent = '⚠ 以下字段未填写，建议补充: ' + data.data.missing.join(', ');
        } else {
          $('missingFields').style.display = 'none';
        }

        $('previewPanel').style.display = 'block';
      } catch (err) {
        $('writeLoading').classList.remove('visible');
        showError('网络请求失败: ' + err.message, 'writeError');
      } finally {
        $('extractBtn').disabled = false;
      }
    }

    async function doWrite() {
      if (!writePreviewData) return;

      const docId = $('writeDocSelect').value;

      try {
        const resp = await fetch('/api/write/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docId,
            sheetId: writePreviewData.sheetId,
            targetRow: writePreviewData.targetRow,
            values: writePreviewData.values
          })
        });
        const data = await resp.json();

        if (!data.success) {
          showError(data.error || '写入失败', 'writeError');
          return;
        }

        showSuccess(data.message);
        $('previewPanel').style.display = 'none';
        $('writeDescription').value = '';
        writePreviewData = null;
      } catch (err) {
        showError('网络请求失败: ' + err.message, 'writeError');
      }
    }

    function cancelWrite() {
      $('previewPanel').style.display = 'none';
      writePreviewData = null;
    }

    // ============================================================
    // 设置功能
    // ============================================================
    async function loadSettings() {
      try {
        const resp = await fetch('/api/config');
        const data = await resp.json();
        if (!data.success) return;

        currentConfig = data.data;

        // 腾讯文档
        $('cfgTencentKey').value = currentConfig.tencentDocs.apiKey || '';
        $('cfgTencentUrl').value = currentConfig.tencentDocs.mcpUrl || '';

        // LLM
        $('cfgLlmProvider').value = currentConfig.llm.provider || 'deepseek';
        $('cfgLlmModel').value = currentConfig.llm.model || '';
        $('cfgLlmKey').value = currentConfig.llm.apiKey || '';
        $('cfgLlmUrl').value = currentConfig.llm.baseUrl || '';

        // 缓存
        $('cfgCacheTtl').value = (currentConfig.cache.ttl || 300000) / 1000;
        $('cfgCacheRefresh').value = (currentConfig.cache.autoRefreshInterval || 1800000) / 1000;

        // 文档列表
        renderDocList();
      } catch (err) {
        console.error('加载设置失败:', err);
      }
    }

    function renderDocList() {
      const container = $('docListContainer');
      container.innerHTML = '';

      if (!currentConfig.documents || currentConfig.documents.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">暂无文档配置</p>';
        return;
      }

      currentConfig.documents.forEach((doc, idx) => {
        const item = document.createElement('div');
        item.className = 'doc-list-item';
        const isDefault = doc.id === currentConfig.defaultDocumentId;
        item.innerHTML = `
          <span class="name">${esc(doc.name)} ${isDefault ? '<span class="tag">默认</span>' : ''}</span>
          <div class="actions">
            <button class="btn btn-secondary btn-icon" onclick="editDocument(${idx})">编辑</button>
            <button class="btn btn-secondary btn-icon" onclick="deleteDocument(${idx})">删除</button>
          </div>
        `;
        container.appendChild(item);
      });
    }

    function addDocument() {
      // 简化实现：通过 prompt 收集信息
      const name = prompt('文档名称（如：和旭电商退货登记）');
      if (!name) return;
      const fileId = prompt('腾讯文档 File ID');
      if (!fileId) return;
      const keywords = prompt('读取 Sheet 关键词（逗号分隔，如：客退,退货）') || '客退,退货';

      const newDoc = {
        id: 'doc' + Date.now(),
        name,
        fileId,
        readSheetKeywords: keywords.split(',').map(s => s.trim()).filter(Boolean),
        writeTargets: []
      };

      currentConfig.documents.push(newDoc);
      if (!currentConfig.defaultDocumentId) {
        currentConfig.defaultDocumentId = newDoc.id;
      }
      renderDocList();
    }

    function editDocument(idx) {
      const doc = currentConfig.documents[idx];
      const name = prompt('文档名称', doc.name);
      if (name) doc.name = name;
      const fileId = prompt('File ID', doc.fileId);
      if (fileId) doc.fileId = fileId;
      const keywords = prompt('读取 Sheet 关键词（逗号分隔）', (doc.readSheetKeywords || []).join(','));
      if (keywords !== null) {
        doc.readSheetKeywords = keywords.split(',').map(s => s.trim()).filter(Boolean);
      }

      // 写入目标配置
      const targetsStr = prompt('写入目标（格式：显示名|sheet名，多个用分号分隔）',
        (doc.writeTargets || []).map(t => t.name + '|' + t.sheetName).join(';'));
      if (targetsStr !== null) {
        doc.writeTargets = targetsStr.split(';').filter(s => s.trim()).map((s, i) => {
          const [name, sheetName] = s.split('|').map(p => p.trim());
          return { id: 'target' + i, name: name || sheetName, sheetName: sheetName || name };
        });
      }

      renderDocList();
    }

    function deleteDocument(idx) {
      if (!confirm('确认删除文档"' + currentConfig.documents[idx].name + '"？')) return;
      const docId = currentConfig.documents[idx].id;
      currentConfig.documents.splice(idx, 1);
      if (currentConfig.defaultDocumentId === docId) {
        currentConfig.defaultDocumentId = currentConfig.documents[0]?.id || '';
      }
      renderDocList();
    }

    function onLlmProviderChange() {
      const provider = $('cfgLlmProvider').value;
      const presets = {
        deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-chat' },
        doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k' },
        qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
        ollama: { url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
        openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
      };
      const preset = presets[provider];
      if (preset) {
        $('cfgLlmUrl').value = preset.url;
        $('cfgLlmModel').value = preset.model;
      }
    }

    async function testLLM() {
      const llmConfig = {
        provider: $('cfgLlmProvider').value,
        apiKey: $('cfgLlmKey').value.includes('****') ? (currentConfig.llm.apiKey || '') : $('cfgLlmKey').value,
        baseUrl: $('cfgLlmUrl').value,
        model: $('cfgLlmModel').value
      };

      try {
        const resp = await fetch('/api/llm/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ llmConfig })
        });
        const data = await resp.json();
        if (data.success) {
          alert('✓ ' + data.message);
        } else {
          alert('✗ ' + data.message);
        }
      } catch (err) {
        alert('✗ 请求失败: ' + err.message);
      }
    }

    async function saveSettings() {
      const config = {
        documents: currentConfig.documents,
        defaultDocumentId: currentConfig.defaultDocumentId,
        tencentDocs: {
          apiKey: $('cfgTencentKey').value,
          mcpUrl: $('cfgTencentUrl').value
        },
        llm: {
          provider: $('cfgLlmProvider').value,
          apiKey: $('cfgLlmKey').value,
          baseUrl: $('cfgLlmUrl').value,
          model: $('cfgLlmModel').value
        },
        cache: {
          ttl: parseInt($('cfgCacheTtl').value) * 1000 || 300000,
          autoRefreshInterval: parseInt($('cfgCacheRefresh').value) * 1000 || 1800000
        }
      };

      try {
        const resp = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        const data = await resp.json();
        if (data.success) {
          alert('配置已保存');
          loadSettings();
        } else {
          alert('保存失败: ' + (data.error || ''));
        }
      } catch (err) {
        alert('保存失败: ' + err.message);
      }
    }

    // ============================================================
    // 初始化
    // ============================================================
    loadDocSelector('queryDocSelect');
```

- [ ] **Step 2: 验证查询功能**

1. 启动服务器
2. 访问 `http://localhost:3000/`
3. 确认文档下拉框有选项
4. 输入快递单号查询，确认结果正常显示

- [ ] **Step 3: 验证设置功能**

1. 点击"设置"Tab
2. 确认配置项正确加载
3. 修改某个配置项，点击保存
4. 刷新页面，确认配置已持久化

- [ ] **Step 4: 验证写入功能（需要 LLM 配置）**

1. 在设置页面配置 LLM API Key
2. 点击"写入"Tab
3. 选择文档和目标表格
4. 输入自然语言描述
5. 点击"提取并预览"
6. 确认预览表格显示正确
7. 点击"确认写入"
8. 确认写入成功

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: add frontend JavaScript for query, write, and settings views"
```

---

## Task 10: 更新管理脚本 — manage.bat 适配

**Files:**
- Modify: `d:\Code\Kuaidi\manage.bat`

更新管理脚本中的系统名称和说明。

- [ ] **Step 1: 更新 manage.bat 中的标题和说明**

将 `manage.bat` 中的 `和旭电商退货查询系统` 替换为 `综合电商售后处理系统`，更新局域网地址说明。

具体修改：
- 第 4 行: `和旭电商退货查询系统 - 服务管理` → `综合电商售后处理系统 - 服务管理`
- 第 29 行: `局域网访问: http://192.168.2.111:3000` → 保持不变（用户自行修改 IP）
- 第 63 行: 同上

- [ ] **Step 2: 验证 manage.bat 可正常运行**

Run: `d:\Code\Kuaidi\manage.bat`
Expected: 菜单显示更新后的标题

- [ ] **Step 3: Commit**

```bash
git add manage.bat
git commit -m "chore: update manage.bat title for v2"
```

---

## Task 11: 集成测试与文档

**Files:**
- Create: `d:\Code\Kuaidi\README.md`

- [ ] **Step 1: 创建 README.md**

```markdown
# 综合电商售后处理系统 v2

可配置、可复用、可读、可写的综合电商售后处理系统。

## 功能

### 查询（读）
- 支持配置多个腾讯文档，下拉切换查询
- 按快递单号搜索退货记录
- 数据自动缓存与定时刷新

### 写入（写）
- 选择目标表格（如：快递理赔登记表、售后换货登记表）
- 用自然语言描述要写入的内容
- LLM 自动识别表头结构并提取数据
- 写入前检查目标行是否为空（防止并发冲突）
- 缺失字段提示用户补充

### 设置
- 配置多个文档地址（File ID、读取关键词、写入目标）
- 配置腾讯文档 API Key
- 配置 LLM（支持 DeepSeek/豆包/通义千问/Ollama 本地/OpenAI）
- 设置默认文档
- 缓存参数配置

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

复制 `config.example.json` 为 `config.json`，填入：
- 腾讯文档 API Key
- 文档 File ID
- LLM API Key 和 Base URL

或启动后访问"设置"页面在线配置。

### 3. 启动

```bash
npm start
```

或双击 `manage.bat` 使用管理工具。

### 4. 访问

- 本机: http://localhost:3000
- 局域网: http://<本机IP>:3000

## LLM 配置说明

| 服务商 | Base URL | 模型示例 |
|--------|----------|---------|
| DeepSeek | https://api.deepseek.com | deepseek-chat |
| 豆包(火山引擎) | https://ark.cn-beijing.volces.com/api/v3 | doubao-1-5-pro-32k |
| 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus |
| Ollama(本地) | http://localhost:11434/v1 | qwen2.5:7b |
| OpenAI | https://api.openai.com/v1 | gpt-4o-mini |

## 技术栈

- Node.js (内置 http 模块，无框架依赖)
- OpenAI SDK (LLM 调用，兼容多厂商)
- Zod (数据校验)
- 腾讯文档 MCP API
- 原生 HTML/CSS/JS 前端
```

- [ ] **Step 2: 运行完整集成测试**

1. `npm install`
2. 配置 `config.json`（填入真实 API Key）
3. `npm start`
4. 访问 `http://localhost:3000/`
5. 测试查询功能（选择文档 → 输入单号 → 查询）
6. 测试设置功能（修改配置 → 保存 → 刷新验证）
7. 测试写入功能（选择表格 → 输入描述 → 提取预览 → 确认写入）
8. 测试 LLM 连接（设置页 → 测试连接）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and usage instructions"
```

---

## 自审检查

### 1. Spec 覆盖检查

| 需求 | 对应 Task | 状态 |
|------|----------|------|
| 可配置多个文档地址 | Task 2 (config.json), Task 7 (API), Task 9 (设置页) | ✅ |
| 配置腾讯文档 API KEY | Task 2 (config.json), Task 7 (API), Task 9 (设置页) | ✅ |
| 配置 LLM KEY | Task 2 (config.json), Task 5 (llm.js), Task 7 (API), Task 9 (设置页) | ✅ |
| 读：查询功能 + 下拉选框选择不同文档 | Task 7 (API), Task 8-9 (前端) | ✅ |
| 设置中可配置默认文档 | Task 2 (config.json defaultDocumentId), Task 9 (设置页) | ✅ |
| 写：接入 LLM（本地/云均可） | Task 5 (llm.js), Task 6 (extractor.js) | ✅ |
| 写：选择需要写入的表格 | Task 2 (writeTargets 配置), Task 9 (前端) | ✅ |
| 写：自然语言描述 | Task 6 (extractor.js), Task 9 (前端) | ✅ |
| 写：LLM 自动识别表头结构 | Task 6 (extractor.js buildSystemPrompt) | ✅ |
| 写：写入空行（检查当前行没人在使用） | Task 7 (write/execute 路由中的行检查) | ✅ |
| 写：未填写的单元格 LLM 告知用户补充 | Task 6 (missing 字段), Task 9 (missingFields 显示) | ✅ |

### 2. 占位符扫描

- Task 4 的 `writeRow` 函数有两种实现方案（情况 A / 情况 B），这是因为 MCP 写入工具的实际 Schema 需要通过 `tools/list` 发现后才能确定。这不是占位符，而是有条件的实现分支。
- 所有其他 Task 的代码都是完整的、可直接使用的。

### 3. 类型一致性检查

- `config.json` 结构在 Task 2 定义，在 Task 7 (server.js) 和 Task 9 (前端) 中使用一致
- `extractRowData` 返回 `{ values, missing, raw }` 在 Task 6 定义，在 Task 7 (write/extract 路由) 中使用一致
- `writeRow` 参数 `(tencentDocsConfig, fileId, sheetId, startRow, values)` 在 Task 4 定义，在 Task 7 (write/execute 路由) 中调用一致
- `loadConfig` / `saveConfig` / `getDocumentById` / `getDefaultDocument` / `validateConfig` 在 Task 2 定义，在 Task 7 中导入使用一致
