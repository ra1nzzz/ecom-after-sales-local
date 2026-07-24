/**
 * shared-docs.js - 文档提供商共享工具模块
 * 提供与提供商无关的通用函数：CSV解析/序列化、记录搜索、状态管理、通用数据获取
 */

// 读取单元格数据时限制的最大列数（可通过环境变量覆盖）
const MAX_COL_COUNT = parseInt(process.env.MAX_COL_COUNT, 10) || 10;

// HTTP 请求统一超时（毫秒）
const REQUEST_TIMEOUT = 60000;

// ===================== 限流错误 =====================

/**
 * 限流错误：HTTP 429 或错误信息包含限流关键词时抛出
 * 携带 isRateLimit 属性，便于上游通过属性检测捕获（跨模块更稳健）
 */
class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
    this.isRateLimit = true;
  }
}

const RATE_LIMIT_KEYWORDS = ['限流', 'rate limit', 'too many requests', 'too many'];

/**
 * 检测文本是否包含限流关键词（不区分大小写）
 */
function isRateLimitMessage(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return RATE_LIMIT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * 创建文档状态对象（适配器可传入额外字段）
 */
function createDocState(extra = {}) {
  return {
    cachedData: null,
    cacheTimestamp: 0,
    cacheLoading: false,
    loadingPromise: null,
    ...extra
  };
}

/**
 * 状态工厂 - 生成 getDocState 函数，保证状态对象契约
 */
function makeGetDocState(extra = {}) {
  const states = new Map();
  return function getDocState(fileId) {
    if (!states.has(fileId)) {
      states.set(fileId, createDocState(extra));
    }
    return states.get(fileId);
  };
}

/**
 * 统一的 clearCache - 重置所有缓存字段（含 cacheLoading），适配器可传入额外清理函数
 */
function makeClearCache(getDocState, extraClear) {
  return function clearCache(fileId) {
    const state = getDocState(fileId);
    state.cachedData = null;
    state.cacheTimestamp = 0;
    state.cacheLoading = false;
    state.loadingPromise = null;
    if (extraClear) extraClear(state);
  };
}

// ===================== CSV 解析与序列化 =====================

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
 * 将 CSV 文本按引号感知方式分割为逻辑行
 * 避免单元格内含换行符时被错误切分
 */
function splitCsvLines(csvText) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // 跳过 \r
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * CSV 单元格转义：含逗号/引号/换行时用双引号包裹
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 将一行值数组转为 CSV 行
 */
function csvRow(cells) {
  return (cells || []).map(csvEscape).join(',');
}

/**
 * 将二维数组转为完整 CSV 文本
 */
function arrayToCsv(rows) {
  return (rows || []).map(csvRow).join('\n');
}

// ===================== 业务字段映射 =====================

/**
 * 售后业务的字段映射规则（可被 docConfig.fieldMap 覆盖）
 */
const DEFAULT_FIELD_MAP = [
  { key: '快递单号', match: ['快递单号', '单号'] },
  { key: '登记日期', match: ['登记日期', '日期'] },
  { key: '商品名称', match: ['商品名称', '货品'] },
  { key: '正品数量', match: ['正品'] },
  { key: '次品备注', match: ['次品备注', '残品备注'] },
  { key: '次品数量', match: ['次品', '残品'] },
  { key: '备注', match: ['备注'], exact: true }
];

/**
 * 将 CSV 文本解析为标准化记录数组
 * @param {string} csvText - CSV 文本
 * @param {string} sheetName - 工作表名称
 * @param {Array} fieldMap - 字段映射规则（默认使用 DEFAULT_FIELD_MAP）
 */
function parseSheetCsv(csvText, sheetName, fieldMap) {
  const fm = fieldMap || DEFAULT_FIELD_MAP;
  const lines = splitCsvLines(csvText).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headerCells = parseCsvLine(lines[0]);

  // 按字段映射规则定位列索引（先匹配长关键词，避免"次品"误匹配"次品备注"）
  const colIndices = {};
  for (const field of fm) {
    for (let i = 0; i < headerCells.length; i++) {
      const h = headerCells[i];
      if (field.exact) {
        if (h === field.match[0]) { colIndices[field.key] = i; break; }
      } else {
        if (field.match.some(m => h.includes(m))) { colIndices[field.key] = i; break; }
      }
    }
  }

  if (colIndices['快递单号'] === undefined) return [];

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const trackingNo = (cells[colIndices['快递单号']] || '').trim();
    if (!trackingNo) continue;

    const record = { _source: sheetName };
    for (const field of fm) {
      const idx = colIndices[field.key];
      record[field.key] = idx !== undefined ? (cells[idx] || '').trim() : '';
    }
    records.push(record);
  }

  return records;
}

/**
 * 按快递单号搜索记录（小写包含匹配）
 */
function searchRecords(records, query) {
  if (!query || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  return (records || []).filter(r => (r['快递单号'] || '').toLowerCase().includes(q));
}

// ===================== 通用数据获取 =====================

/**
 * 通用数据获取函数 - 适用于所有提供商
 * 使用 Promise 去重替代 setInterval 轮询，正确传播错误
 * adapter 需要实现: init, getSheetList, readSheetCsv, getDocState, clearCache
 */
async function fetchData(adapter, docConfig, providerConfig, cacheTTL) {
  const state = adapter.getDocState(docConfig.fileId);
  const now = Date.now();

  // 缓存命中
  if (state.cachedData && (now - state.cacheTimestamp) < cacheTTL) {
    return state.cachedData;
  }

  // 并发去重：复用正在进行的加载 Promise
  if (state.loadingPromise) {
    return state.loadingPromise;
  }

  state.loadingPromise = (async () => {
    try {
      state.cacheLoading = true;
      if (adapter.init) await adapter.init(providerConfig, state);
      const sheets = await adapter.getSheetList(providerConfig, state, docConfig.fileId);

      const keywords = docConfig.readSheetKeywords || [];
      const dataSheets = keywords.length > 0
        ? sheets.filter(sheet => keywords.some(kw => sheet.sheet_name.includes(kw)))
        : sheets;

      const results = await Promise.allSettled(
        dataSheets.map(sheet =>
          adapter.readSheetCsv(providerConfig, state, docConfig.fileId, sheet.sheet_id, sheet.row_count, sheet.col_count)
            .then(csv => parseSheetCsv(csv, sheet.sheet_name))
        )
      );

      const allRecords = [];
      let hasFailure = false;
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          const val = results[i].value;
          // 逐条 push 避免大数组 spread 栈溢出
          for (let j = 0; j < val.length; j++) {
            allRecords.push(val[j]);
          }
        } else {
          hasFailure = true;
          console.error(`    读取失败 [${dataSheets[i].sheet_name}]: ${results[i].reason.message}`);
        }
      }

      // 仅在有数据或全部成功时更新缓存，避免瞬时故障固化为空缓存
      if (allRecords.length > 0 || !hasFailure) {
        state.cachedData = allRecords;
        state.cacheTimestamp = Date.now();
      }
      return allRecords;
    } catch (err) {
      if (state.cachedData) return state.cachedData;
      throw err;
    } finally {
      state.cacheLoading = false;
      state.loadingPromise = null;
    }
  })();

  return state.loadingPromise;
}

module.exports = {
  MAX_COL_COUNT,
  REQUEST_TIMEOUT,
  RateLimitError,
  isRateLimitMessage,
  DEFAULT_FIELD_MAP,
  createDocState,
  makeGetDocState,
  makeClearCache,
  parseCsvLine,
  splitCsvLines,
  csvEscape,
  csvRow,
  arrayToCsv,
  parseSheetCsv,
  searchRecords,
  fetchData
};
