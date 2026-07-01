/**
 * shared-docs.js - 文档提供商共享工具模块
 * 提供与提供商无关的通用函数：CSV解析、记录搜索、通用数据获取
 */

// 读取单元格数据时限制的最大列数
const MAX_COL_COUNT = 10;

/**
 * 解析 CSV 单行，支持引号转义
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
 * 将 CSV 文本解析为标准化记录数组
 * 按表头关键词定位列：快递单号、登记日期、商品名称、正品、次品、次品备注、备注
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
 * 按快递单号搜索记录（小写包含匹配）
 */
function searchRecords(records, query) {
  if (!query || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  return records.filter(r => (r['快递单号'] || '').toLowerCase().includes(q));
}

/**
 * 通用数据获取函数 - 适用于所有提供商
 * adapter 需要实现: init, getSheetList, readSheetCsv, getDocState, clearCache
 */
async function fetchData(adapter, docConfig, providerConfig, cacheTTL) {
  const state = adapter.getDocState(docConfig.fileId);
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
    if (adapter.init) await adapter.init(providerConfig, state);
    const sheets = await adapter.getSheetList(providerConfig, state, docConfig.fileId);

    const keywords = docConfig.readSheetKeywords || ['客退', '退货'];
    const dataSheets = sheets.filter(sheet => keywords.some(kw => sheet.sheet_name.includes(kw)));

    const results = await Promise.allSettled(
      dataSheets.map(sheet =>
        adapter.readSheetCsv(providerConfig, state, docConfig.fileId, sheet.sheet_id, sheet.row_count, sheet.col_count)
          .then(csv => parseSheetCsv(csv, sheet.sheet_name))
      )
    );

    const allRecords = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        allRecords.push(...results[i].value);
      } else {
        console.error(`    读取失败 [${dataSheets[i].sheet_name}]: ${results[i].reason.message}`);
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

module.exports = {
  MAX_COL_COUNT,
  parseCsvLine,
  parseSheetCsv,
  searchRecords,
  fetchData
};
