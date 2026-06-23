const https = require('https');

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

function searchRecords(records, query) {
  if (!query || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  return records.filter(r => (r['快递单号'] || '').toLowerCase().includes(q));
}

function clearCache(fileId) {
  const state = getDocState(fileId);
  state.cachedData = null;
  state.cacheTimestamp = 0;
  state.mcpSessionId = null;
}

async function writeRow(tencentDocsConfig, fileId, sheetId, startRow, values) {
  const state = getDocState(fileId);
  await initMcp(tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state);

  const MCP_ROW_OFFSET = 1;
  const cellValues = values.map((val, idx) => ({
    row: startRow + MCP_ROW_OFFSET,
    col: idx + MCP_ROW_OFFSET,
    value_type: 'STRING',
    string_value: String(val)
  }));

  const args = {
    file_id: fileId,
    sheet_id: sheetId,
    values: cellValues
  };

  const { result, sessionId } = await callTool(
    tencentDocsConfig.mcpUrl, tencentDocsConfig.apiKey, state.mcpSessionId,
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

module.exports = {
  getSheetList,
  readSheetCsv,
  readSheetHeaders: readSheetCsv,
  parseCsvLine,
  parseSheetCsv,
  fetchData,
  searchRecords,
  clearCache,
  initMcp,
  callTool,
  extractText,
  getDocState,
  writeRow
};
