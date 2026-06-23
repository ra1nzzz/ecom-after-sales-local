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
      const targetFileId = target.fileId || doc.fileId;
      const state = tencentDocs.getDocState(targetFileId);
      await tencentDocs.initMcp(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state);
      const sheets = await tencentDocs.getSheetList(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state, targetFileId);

      const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];
      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '文档中未找到任何工作表' });
        return;
      }

      const csv = await tencentDocs.readSheetCsv(
        config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state,
        targetFileId, sheet.sheet_id, Math.min(sheet.row_count, 50), sheet.col_count
      );

      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length === 0) {
        sendJSON(res, 400, { success: false, error: '工作表为空' });
        return;
      }
      const headers = tencentDocs.parseCsvLine(lines[0]);

      sendJSON(res, 200, {
        success: true,
        data: {
          headers,
          sheetName: sheet.sheet_name,
          sheetId: sheet.sheet_id,
          targetFileId: targetFileId,
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
      const targetFileId = target.fileId || doc.fileId;
      const state = tencentDocs.getDocState(targetFileId);
      await tencentDocs.initMcp(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state);
      const sheets = await tencentDocs.getSheetList(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state, targetFileId);
      const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];

      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '文档中未找到任何工作表' });
        return;
      }

      const csv = await tencentDocs.readSheetCsv(
        config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state,
        targetFileId, sheet.sheet_id, Math.min(sheet.row_count, 50), sheet.col_count
      );

      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length === 0) {
        sendJSON(res, 400, { success: false, error: '工作表为空' });
        return;
      }
      const headers = tencentDocs.parseCsvLine(lines[0]);

      const extractResult = await extractRowData(config.llm, headers, target.name, description);
      if (extractResult.nonEmptyCount === 0) {
        sendJSON(res, 400, { success: false, error: '未能从描述中提取到任何有效数据，请检查输入内容' });
        return;
      }

      let emptyRowIndex = lines.length;
      for (let i = 1; i < lines.length; i++) {
        const cells = tencentDocs.parseCsvLine(lines[i]);
        const isEmpty = cells.every(c => !c || !c.trim());
        if (isEmpty) {
          emptyRowIndex = i;
          break;
        }
      }

      sendJSON(res, 200, {
        success: true,
        data: {
          headers,
          values: extractResult.values,
          missing: extractResult.missing,
          targetRow: emptyRowIndex,
          sheetName: sheet.sheet_name,
          sheetId: sheet.sheet_id,
          targetFileId: targetFileId,
          preview: buildPreviewText(headers, extractResult.values),
          debug: {
            method: extractResult.method,
            parseTime: extractResult.parseTime,
            llmRaw: extractResult.raw,
            llmError: extractResult.llmError,
            nonEmptyCount: extractResult.nonEmptyCount,
            headerCount: headers.length,
            totalLines: lines.length
          }
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
    const { docId, targetFileId, sheetId, targetRow, values } = body;

    const doc = getDocumentById(config, docId || config.defaultDocumentId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    if (!values || !Array.isArray(values)) {
      sendJSON(res, 400, { success: false, error: '写入数据无效' });
      return;
    }

    const nonEmptyCount = values.filter(v => v && String(v).trim()).length;
    if (nonEmptyCount === 0) {
      sendJSON(res, 400, { success: false, error: '写入数据全为空，已阻止写入' });
      return;
    }

    const writeDocId = targetFileId || doc.fileId;

    try {
      const state = tencentDocs.getDocState(writeDocId);
      const sheets = await tencentDocs.getSheetList(config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state, writeDocId);
      const sheet = sheets.find(s => s.sheet_id === sheetId);
      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '未找到指定工作表' });
        return;
      }

      const checkCsv = await tencentDocs.readSheetCsv(
        config.tencentDocs.mcpUrl, config.tencentDocs.apiKey, state,
        writeDocId, sheetId, targetRow + 1, sheet.col_count
      );
      const checkLines = checkCsv.split('\n').filter(l => l.trim());
      if (checkLines.length > targetRow) {
        const rowCells = tencentDocs.parseCsvLine(checkLines[targetRow] || '');
        const hasData = rowCells.some(c => c && c.trim());
        if (hasData) {
          sendJSON(res, 409, { success: false, error: '目标行已有数据，可能正在被其他人使用，请重新提取' });
          return;
        }
      }

      const result = await tencentDocs.writeRow(
        config.tencentDocs, writeDocId, sheetId, targetRow, values
      );

      tencentDocs.clearCache(writeDocId);

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

  const { valid, errors } = validateConfig(config);
  if (!valid) {
    console.log('\n⚠ 配置不完整:');
    errors.forEach(e => console.log('  - ' + e));
    console.log('  请访问 http://localhost:' + PORT + ' 的"设置"页面完善配置');
  }

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
