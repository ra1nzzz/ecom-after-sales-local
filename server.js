/**
 * 综合电商售后处理系统 - 后端服务 v2
 * 可配置、可复用、可读、可写
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// 简易 .env 加载器
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
})();

const { loadConfig, saveConfig, getDocumentById, getWriteDefaultDocument, validateConfig } = require('./src/config');
const docProvider = require('./src/doc-provider');
const { testConnection: testLLMConnection } = require('./src/llm');
const { extractRowData, buildPreviewText } = require('./src/extractor');
const wangdian = require('./src/wangdian');
const { autoMatchWdtOrder, mergeWdtData } = wangdian;

const PORT = 3000;
const HOST = '0.0.0.0';
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 请求体大小上限：10MB，防止 DoS
const MAX_DESCRIPTION_LENGTH = 5000; // LLM 提取描述的最大字符数
const HEADER_SAMPLE_ROW_LIMIT = 50; // 读取表头采样时的最大行数

let config = loadConfig();

const EMPTY_ROW_BATCH_SIZE = 50;

// 从 startRow 开始查找第一个全空行，用于追加写入
// 如果适配器自带 findEmptyRow（如金山），则使用适配器实现；否则走默认批次扫描
async function findNextEmptyRow(doc, state, fileId, sheetId, startRow, colCount, maxRowCount) {
  // 优先使用适配器自带的 findEmptyRow
  const adapterRow = await docProvider.findEmptyRow(doc, config, state, fileId, sheetId, startRow, colCount, maxRowCount);
  if (adapterRow !== null) return adapterRow;

  // 默认：按批次扫描（腾讯/飞书）
  let currentRow = startRow;
  while (currentRow < maxRowCount) {
    const endRow = Math.min(currentRow + EMPTY_ROW_BATCH_SIZE, maxRowCount);
    const csv = await docProvider.readSheetCsv(doc, config, state, fileId, sheetId, endRow, colCount, currentRow);
    const allLines = csv.split('\n');
    const expectedRows = endRow - currentRow;
    for (let i = 0; i < Math.min(allLines.length, expectedRows); i++) {
      const cells = docProvider.parseCsvLine(allLines[i]);
      if (cells.every(c => !c || !c.trim())) {
        return currentRow + i;
      }
    }
    currentRow += EMPTY_ROW_BATCH_SIZE;
  }
  return maxRowCount;
}

// 缓存 HTML 文件到内存，避免每次请求都读磁盘
let htmlCache = null;
function getIndexHtml() {
  if (!htmlCache) {
    htmlCache = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
  }
  return htmlCache;
}

function maskApiKey(key) {
  if (!key) return key;
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

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
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { tooLarge = true; req.destroy(); resolve({}); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleRequest(req, res) {
  try {
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
      const html = getIndexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  // --- 设置密码 API ---
  if (url.pathname === '/api/settings/password-status' && req.method === 'GET') {
    const hasPassword = !!(process.env.SETTINGS_PASSWORD && process.env.SETTINGS_PASSWORD.trim());
    sendJSON(res, 200, { success: true, data: { hasPassword } });
    return;
  }

  if (url.pathname === '/api/settings/password' && req.method === 'POST') {
    const body = await readBody(req);
    const action = body.action;
    const password = String(body.password || '').trim();
    if (action === 'set') {
      if (!password) {
        sendJSON(res, 400, { success: false, error: '密码不能为空' });
        return;
      }
      // 安全：已设置密码时，禁止通过 set 覆盖（防止未授权重置）
      const existing = process.env.SETTINGS_PASSWORD;
      if (existing && existing.trim()) {
        sendJSON(res, 403, { success: false, error: '密码已设置，如需修改请先重启服务并清除环境变量 SETTINGS_PASSWORD' });
        return;
      }
      try {
        // 先更新内存，立即响应前端
        process.env.SETTINGS_PASSWORD = password;
        // 安全：使用 execFile（不经 shell）避免命令注入
        // 密码通过 stdin 传递给 PowerShell，完全不进入命令行参数
        const { execFile } = require('child_process');
        const psScript = `
          $line = [Console]::In.ReadToEnd().TrimEnd()
          [Environment]::SetEnvironmentVariable('SETTINGS_PASSWORD', $line, 'User')
        `;
        const child = execFile(
          'powershell.exe',
          ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', psScript],
          { stdio: ['pipe', 'ignore', 'ignore'] },
          (err) => {
            if (err) console.error('[settings] 持久化密码失败:', err.message);
            else console.log('[settings] 访问密码已持久化到 Windows 用户环境变量');
          }
        );
        // 通过 stdin 写入密码，避免出现在进程命令行中
        child.stdin.write(password);
        child.stdin.end();
        sendJSON(res, 200, { success: true, message: '访问密码已设置' });
      } catch (err) {
        sendJSON(res, 500, { success: false, error: '设置密码失败: ' + err.message });
      }
      return;
    }
    if (action === 'verify') {
      const current = process.env.SETTINGS_PASSWORD || '';
      if (!current) {
        sendJSON(res, 400, { success: false, error: '尚未设置访问密码' });
        return;
      }
      if (password === current) {
        sendJSON(res, 200, { success: true, message: '验证通过' });
      } else {
        sendJSON(res, 401, { success: false, error: '密码错误' });
      }
      return;
    }
    sendJSON(res, 400, { success: false, error: '未知操作' });
    return;
  }

  // --- 版本 API ---
  if (url.pathname === '/api/version' && req.method === 'GET') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      sendJSON(res, 200, { success: true, data: { version: pkg.version } });
    } catch (err) {
      sendJSON(res, 200, { success: true, data: { version: 'unknown' } });
    }
    return;
  }

  // --- 配置 API ---
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const safeConfig = JSON.parse(JSON.stringify(config));
    const { ADAPTER_META } = docProvider;
    for (const meta of Object.values(ADAPTER_META)) {
      const cfg = safeConfig[meta.configKey];
      if (cfg) {
        for (const f of meta.sensitiveFields) {
          if (cfg[f]) cfg[f] = maskApiKey(cfg[f]);
        }
      }
    }
    safeConfig.llm.apiKey = maskApiKey(safeConfig.llm.apiKey);
    sendJSON(res, 200, { success: true, data: safeConfig });
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      const newConfig = { ...config };
      newConfig.documents = body.documents || config.documents;
      newConfig.queryDefaultDocumentId = body.queryDefaultDocumentId || config.queryDefaultDocumentId;
      newConfig.writeDefaultDocumentId = body.writeDefaultDocumentId || config.writeDefaultDocumentId;
      newConfig.cache = body.cache || config.cache;

      const { ADAPTER_META } = docProvider;
      for (const meta of Object.values(ADAPTER_META)) {
        if (body[meta.configKey]) {
          const existing = config[meta.configKey] || {};
          const incoming = body[meta.configKey];
          const merged = {};
          // Get all unique keys
          const allKeys = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
          for (const key of allKeys) {
            if (meta.sensitiveFields.includes(key)) {
              merged[key] = (incoming[key] && !String(incoming[key]).includes('****'))
                ? incoming[key] : (existing[key] || '');
            } else {
              merged[key] = incoming[key] !== undefined ? incoming[key] : (existing[key] || '');
            }
          }
          newConfig[meta.configKey] = merged;
        }
      }

      if (body.llm) {
        newConfig.llm = {
          provider: body.llm.provider || config.llm.provider,
          customProviderName: body.llm.customProviderName !== undefined
            ? body.llm.customProviderName : config.llm.customProviderName,
          apiKey: (body.llm.apiKey && !body.llm.apiKey.includes('****'))
            ? body.llm.apiKey : config.llm.apiKey,
          baseUrl: body.llm.baseUrl || config.llm.baseUrl,
          model: body.llm.model || config.llm.model
        };
      }

      saveConfig(newConfig);
      config = loadConfig();
      for (const doc of config.documents) {
        docProvider.clearCache(doc, doc.fileId);
      }
      // 清理旧字段，避免混淆
      if ('defaultDocumentId' in newConfig) {
        delete newConfig.defaultDocumentId;
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
      queryDefault: d.id === config.queryDefaultDocumentId,
      writeDefault: d.id === config.writeDefaultDocumentId,
      writeTargetCount: (d.writeTargets || []).length
    }));
    sendJSON(res, 200, { success: true, data: docs });
    return;
  }

  // --- 查询 API（支持多文档） ---
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const docId = url.searchParams.get('docId') || config.queryDefaultDocumentId;

    const doc = getDocumentById(config, docId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    try {
      const records = await docProvider.fetchData(doc, config, config.cache.ttl);
      const results = docProvider.searchRecords(records, query);
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
    const docId = url.searchParams.get('docId') || config.queryDefaultDocumentId;
    const doc = getDocumentById(config, docId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }
    try {
      docProvider.clearCache(doc, doc.fileId);
      const records = await docProvider.fetchData(doc, config, config.cache.ttl);
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

  // --- 旺店通ERP查询 ---
  if (url.pathname === '/api/wdt/query' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) {
      sendJSON(res, 400, { success: false, error: '查询内容不能为空' });
      return;
    }
    const wdtCfg = config.wangdian || {};
    if (!wdtCfg.sid || !wdtCfg.key || !wdtCfg.secret || !wdtCfg.salt) {
      sendJSON(res, 400, { success: false, error: '旺店通API未配置，请在环境变量或配置文件中设置WDT_SID/WDT_KEY/WDT_SECRET/WDT_SALT' });
      return;
    }
    try {
      const result = await wangdian.queryOrder(wdtCfg, q);
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // --- 写入：获取表头 ---
  if (url.pathname === '/api/write/headers' && req.method === 'GET') {
    const docId = url.searchParams.get('docId') || config.writeDefaultDocumentId;
    const targetId = url.searchParams.get('targetId');

    const doc = getDocumentById(config, docId || config.writeDefaultDocumentId);
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
      const adapter = docProvider.getAdapter(doc);
      const providerConfig = docProvider.getProviderConfig(config, doc);
      const state = adapter.getDocState(targetFileId);
      if (adapter.init) await adapter.init(providerConfig, state);
      const sheets = await adapter.getSheetList(providerConfig, state, targetFileId);

      const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];
      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '文档中未找到任何工作表' });
        return;
      }

      const csv = await adapter.readSheetCsv(
        providerConfig, state,
        targetFileId, sheet.sheet_id, Math.min(sheet.row_count, HEADER_SAMPLE_ROW_LIMIT), sheet.col_count
      );

      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length === 0) {
        sendJSON(res, 400, { success: false, error: '工作表为空' });
        return;
      }
      const headers = docProvider.parseCsvLine(lines[0]);
      // 去除标题行末尾连续的空列，避免写入时产生多余空列导致视觉错位
      while (headers.length > 0 && !headers[headers.length - 1].trim()) {
        headers.pop();
      }

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

    const doc = getDocumentById(config, docId || config.writeDefaultDocumentId);
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
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      sendJSON(res, 400, { success: false, error: `描述内容过长，最大支持 ${MAX_DESCRIPTION_LENGTH} 个字符` });
      return;
    }

    try {
      const targetFileId = target.fileId || doc.fileId;
      const adapter = docProvider.getAdapter(doc);
      const providerConfig = docProvider.getProviderConfig(config, doc);
      const state = adapter.getDocState(targetFileId);
      if (adapter.init) await adapter.init(providerConfig, state);
      const sheets = await adapter.getSheetList(providerConfig, state, targetFileId);
      const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];

      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '文档中未找到任何工作表' });
        return;
      }

      const csv = await adapter.readSheetCsv(
        providerConfig, state,
        targetFileId, sheet.sheet_id, Math.min(sheet.row_count, HEADER_SAMPLE_ROW_LIMIT), sheet.col_count
      );

      const allLines = csv.split('\n');
      const lines = allLines.filter(l => l.trim());
      if (lines.length === 0) {
        sendJSON(res, 400, { success: false, error: '工作表为空' });
        return;
      }
      const headers = docProvider.parseCsvLine(lines[0]);
      // 去除标题行末尾连续的空列，避免写入时产生多余空列导致视觉错位
      while (headers.length > 0 && !headers[headers.length - 1].trim()) {
        headers.pop();
      }

      // 并行执行：LLM 提取 + 旺店通自动匹配（两者互不依赖）
      const wdtCfg = config.wangdian || {};
      const wdtEnabled = wdtCfg.sid && wdtCfg.key && wdtCfg.secret && wdtCfg.salt;

      const [extractResult, wdtMatch] = await Promise.all([
        extractRowData(config.llm, headers, target.name, description),
        wdtEnabled ? autoMatchWdtOrder(wdtCfg, description) : Promise.resolve(null)
      ]);

      // 合并旺店通数据到提取结果
      if (wdtMatch) {
        mergeWdtData(headers, extractResult, wdtMatch);
      }

      if (extractResult.nonEmptyCount === 0) {
        sendJSON(res, 400, { success: false, error: '未能从描述中提取到任何有效数据，请检查输入内容' });
        return;
      }

      // 查找第一个空行时保留空行，避免跳过空行导致追加时间隔一行
      let emptyRowIndex = allLines.length;
      for (let i = 1; i < allLines.length; i++) {
        const cells = docProvider.parseCsvLine(allLines[i]);
        const isEmpty = cells.every(c => !c || !c.trim());
        if (isEmpty) {
          emptyRowIndex = i;
          break;
        }
      }

      // --- 查重检测 ---
      // 找到物流单号列索引
      const logisticsColIdx = headers.findIndex(h => {
        const name = (h || '').trim();
        return name === '快递单号' || name === '物流单号';
      });

      let duplicateInfo = null;
      if (logisticsColIdx >= 0) {
        const newLogisticsNo = (extractResult.values[logisticsColIdx] || '').trim();
        if (newLogisticsNo) {
          // 在已有行中搜索匹配的物流单号
          for (let i = 1; i < allLines.length; i++) {
            const rowCells = docProvider.parseCsvLine(allLines[i]);
            const existingNo = (rowCells[logisticsColIdx] || '').trim();
            if (existingNo === newLogisticsNo) {
              // 补齐 rowCells 到 headers 长度
              while (rowCells.length < headers.length) rowCells.push('');
              const existingValues = headers.map((_, idx) => rowCells[idx] || '');

              // 判断是否信息完整（排除"备注"列）
              const emptyFieldIndices = [];
              for (let j = 0; j < headers.length; j++) {
                const headerName = (headers[j] || '').trim();
                const isRemark = headerName === '备注' || headerName === 'remark';
                const val = (existingValues[j] || '').trim();
                if (!val && !isRemark) {
                  emptyFieldIndices.push(j);
                }
              }

              const isComplete = emptyFieldIndices.length === 0;

              if (isComplete) {
                // Case 1: 已完整登记，提示是否覆盖
                duplicateInfo = {
                  type: 'overwrite',
                  existingRow: i,
                  existingValues: existingValues,
                  newValues: extractResult.values.slice(),
                  changedFields: []
                };
                // 找出有差异的字段
                for (let j = 0; j < headers.length; j++) {
                  const oldVal = (existingValues[j] || '').trim();
                  const newVal = (extractResult.values[j] || '').trim();
                  if (oldVal !== newVal) {
                    duplicateInfo.changedFields.push({
                      col: j,
                      header: headers[j],
                      oldValue: existingValues[j] || '',
                      newValue: extractResult.values[j] || ''
                    });
                  }
                }
              } else {
                // Case 2: 登记不全，自动补全空缺字段
                const mergedValues = existingValues.slice();
                const filledFields = [];
                for (let j = 0; j < headers.length; j++) {
                  const existingVal = (existingValues[j] || '').trim();
                  const newVal = (extractResult.values[j] || '').trim();
                  if (!existingVal && newVal) {
                    mergedValues[j] = newVal;
                    filledFields.push({
                      col: j,
                      header: headers[j],
                      oldValue: '',
                      newValue: newVal
                    });
                  }
                }
                duplicateInfo = {
                  type: 'merge',
                  existingRow: i,
                  existingValues: existingValues,
                  newValues: extractResult.values.slice(),
                  mergedValues: mergedValues,
                  filledFields: filledFields,
                  emptyFieldIndices: emptyFieldIndices
                };
              }
              break; // 找到第一个匹配即停止
            }
          }
        }
      }

      // 如果查重命中，使用已有行作为目标行
      const finalTargetRow = duplicateInfo ? duplicateInfo.existingRow : emptyRowIndex;
      // 如果是合并模式，使用合并后的值
      const finalValues = (duplicateInfo && duplicateInfo.type === 'merge')
        ? duplicateInfo.mergedValues
        : extractResult.values;

      sendJSON(res, 200, {
        success: true,
        data: {
          headers,
          values: finalValues,
          missing: extractResult.missing,
          targetRow: finalTargetRow,
          sheetName: sheet.sheet_name,
          sheetId: sheet.sheet_id,
          targetFileId: targetFileId,
          preview: buildPreviewText(headers, finalValues),
          duplicate: duplicateInfo,
          debug: {
            method: extractResult.method,
            parseTime: extractResult.parseTime,
            llmRaw: extractResult.raw,
            llmError: extractResult.llmError,
            nonEmptyCount: extractResult.nonEmptyCount,
            headerCount: headers.length,
            totalLines: lines.length,
            wdtMatch: wdtMatch ? { src_tids: wdtMatch.src_tids, logistics_no: wdtMatch.logistics_no, shop_name: wdtMatch.shop_name, platform: wdtMatch.platform, warehouse_no: wdtMatch.warehouse_no, warehouse_name: wdtMatch.warehouse_name } : null
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
    const { docId, targetFileId, sheetId, targetRow, values, isDuplicate } = body;

    const doc = getDocumentById(config, docId || config.writeDefaultDocumentId);
    if (!doc) {
      sendJSON(res, 400, { success: false, error: '未找到指定文档' });
      return;
    }

    if (!values || !Array.isArray(values)) {
      sendJSON(res, 400, { success: false, error: '写入数据无效' });
      return;
    }
    if (!Number.isInteger(targetRow) || targetRow < 0) {
      sendJSON(res, 400, { success: false, error: '目标行号无效' });
      return;
    }

    const nonEmptyCount = values.filter(v => v && String(v).trim()).length;
    if (nonEmptyCount === 0) {
      sendJSON(res, 400, { success: false, error: '写入数据全为空，已阻止写入' });
      return;
    }

    const writeDocId = targetFileId || doc.fileId;

    try {
      const adapter = docProvider.getAdapter(doc);
      const providerConfig = docProvider.getProviderConfig(config, doc);
      const state = adapter.getDocState(writeDocId);
      const sheets = await adapter.getSheetList(providerConfig, state, writeDocId);
      const sheet = sheets.find(s => s.sheet_id === sheetId);
      if (!sheet) {
        sendJSON(res, 400, { success: false, error: '未找到指定工作表' });
        return;
      }

      // 查重命中时直接使用已有行号更新，不重新查找空行
      // 非查重场景才查找空行用于追加
      let actualRow;
      if (isDuplicate) {
        actualRow = targetRow;
      } else {
        actualRow = await findNextEmptyRow(
          doc, state,
          writeDocId, sheetId, targetRow, sheet.col_count, sheet.row_count
        );
      }

      const result = await adapter.writeRow(providerConfig, state, writeDocId, sheetId, actualRow, values);

      adapter.clearCache(writeDocId);

      sendJSON(res, 200, {
        success: true,
        message: `登记成功，更新了 ${result.updateNum} 个单元格`,
        data: { updateNum: result.updateNum, row: actualRow }
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
  } catch (err) {
    if (!res.headersSent) {
      sendJSON(res, 500, { success: false, error: '服务器内部错误: ' + err.message });
    } else {
      console.error('[server] 未捕获的错误:', err);
    }
  }
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
      // 并行刷新所有文档，减少刷新总耗时
      const results = await Promise.allSettled(
        config.documents.map(doc => {
          docProvider.clearCache(doc, doc.fileId);
          return docProvider.fetchData(doc, config, config.cache.ttl)
            .then(records => ({ name: doc.name, count: records.length }));
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          console.log(`[自动刷新] ${r.value.name} — ${r.value.count} 条记录`);
        } else {
          console.error(`[自动刷新] 失败: ${r.reason.message}`);
        }
      });
    }, config.cache.autoRefreshInterval);
  }
});
