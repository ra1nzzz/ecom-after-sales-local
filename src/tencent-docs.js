/**
 * tencent-docs.js - 腾讯文档适配器（统一适配器接口）
 *
 * 实现 shared-docs.js 定义的统一适配器接口：
 *   init / getSheetList / readSheetCsv / writeRow / getDocState / clearCache
 * 其中 providerConfig = { apiKey, mcpUrl }
 *
 * 通用工具（parseCsvLine / parseSheetCsv / searchRecords / fetchData）
 * 已抽取到 ./shared-docs，这里重新导出以保持向后兼容。
 */

const https = require('https');
const {
  MAX_COL_COUNT,
  parseCsvLine,
  parseSheetCsv,
  searchRecords,
  fetchData: sharedFetchData
} = require('./shared-docs');

// ---- 文档状态管理 ----
const docStates = new Map();

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

function clearCache(fileId) {
  const state = getDocState(fileId);
  state.cachedData = null;
  state.cacheTimestamp = 0;
  state.mcpSessionId = null;
}

// ---- MCP 内部通信函数（不直接导出） ----
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
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`MCP API 返回错误状态码 ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
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
  // 通知类消息无需等待响应，但仍需消费响应体以避免 socket 泄漏
  const req = https.request(options, (res) => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

async function callTool(mcpUrl, apiKey, sessionId, name, args) {
  const { result, sessionId: newSessionId } = await callMcpApi(mcpUrl, apiKey, 'tools/call', { name, arguments: args }, sessionId);
  return { result, sessionId: newSessionId };
}

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

// ---- 统一适配器接口 ----
// providerConfig = { apiKey, mcpUrl }

async function init(providerConfig, state) {
  const { mcpUrl, apiKey } = providerConfig;
  if (state.mcpSessionId) return;
  const { sessionId } = await callMcpApi(mcpUrl, apiKey, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kuaidi-after-sales', version: '2.0.1' }
  }, null);
  state.mcpSessionId = sessionId;
  sendMcpNotification(mcpUrl, apiKey, 'notifications/initialized', {}, sessionId);
  await new Promise(r => setTimeout(r, 500));
}

async function getSheetList(providerConfig, state, fileId) {
  const { mcpUrl, apiKey } = providerConfig;
  const { result, sessionId } = await callTool(mcpUrl, apiKey, state.mcpSessionId, 'sheet.get_sheet_info', { file_id: fileId });
  state.mcpSessionId = sessionId;
  const text = extractText(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed.sheets) return parsed.sheets;
  } catch (e) { /* 响应非JSON格式，返回空数组 */ }
  return [];
}

async function readSheetCsv(providerConfig, state, fileId, sheetId, rowCount, colCount, startRow = 0) {
  const { mcpUrl, apiKey } = providerConfig;
  const { result, sessionId } = await callTool(mcpUrl, apiKey, state.mcpSessionId, 'sheet.get_cell_data', {
    file_id: fileId,
    sheet_id: sheetId,
    start_row: Math.max(0, startRow),
    end_row: rowCount,
    start_col: 0,
    end_col: Math.min(colCount, MAX_COL_COUNT),
    return_csv: true
  });
  state.mcpSessionId = sessionId;
  return extractText(result);
}

async function writeRow(providerConfig, fileId, sheetId, startRow, values) {
  const { mcpUrl, apiKey } = providerConfig;
  const state = getDocState(fileId);
  await init(providerConfig, state);

  // 腾讯文档 sheet.set_range_value 接口中：
  // - row 为 0-based（从 0 开始）
  // - col 为 0-based（从 0 开始）
  const cellValues = values.map((val, idx) => ({
    row: startRow,
    col: idx,
    value_type: 'STRING',
    string_value: String(val)
  }));

  const args = {
    file_id: fileId,
    sheet_id: sheetId,
    values: cellValues
  };

  const { result, sessionId } = await callTool(
    mcpUrl, apiKey, state.mcpSessionId,
    'sheet.set_range_value', args
  );
  state.mcpSessionId = sessionId;

  const text = extractText(result);
  try {
    const parsed = JSON.parse(text);
    return { updateNum: parsed.update_num || cellValues.length };
  } catch (e) {
    return { updateNum: cellValues.length };
  }
}

// ---- 向后兼容封装 ----

// 旧签名 initMcp(mcpUrl, apiKey, state) → 委托给统一接口 init
async function initMcp(mcpUrl, apiKey, state) {
  return init({ mcpUrl, apiKey }, state);
}

// 适配器对象，供共享 fetchData 使用
const tencentAdapter = {
  init,
  getSheetList,
  readSheetCsv,
  getDocState,
  clearCache
};

// 向后兼容的 fetchData：保持原有签名 (docConfig, providerConfig, cacheTTL)
// 内部委托给 shared-docs 的 fetchData(adapter, docConfig, providerConfig, cacheTTL)
function fetchData(docConfig, providerConfig, cacheTTL) {
  return sharedFetchData(tencentAdapter, docConfig, providerConfig, cacheTTL);
}

module.exports = {
  // 统一适配器接口
  init,
  getSheetList,
  readSheetCsv,
  readSheetHeaders: readSheetCsv,
  writeRow,
  getDocState,
  clearCache,
  // 向后兼容：共享工具（从 shared-docs 重新导出）
  parseCsvLine,
  parseSheetCsv,
  searchRecords,
  fetchData,
  // 向后兼容：MCP 专用函数
  initMcp,
  callTool,
  extractText
};
