/**
 * doc-provider.js - 文档提供商调度器
 * 根据文档的 provider 字段路由到对应的适配器模块
 */

const tencentDocs = require('./tencent-docs');
const feishuDocs = require('./feishu-docs');
const jinshanDocs = require('./jinshan-docs');
const shared = require('./shared-docs');

const PROVIDERS = {
  tencent: tencentDocs,
  feishu: feishuDocs,
  jinshan: jinshanDocs
};

const PROVIDER_LABELS = {
  tencent: '腾讯文档',
  feishu: '飞书',
  jinshan: '金山文档'
};

const PROVIDER_ID_LABELS = {
  tencent: 'File ID',
  feishu: 'Spreadsheet Token',
  jinshan: 'File ID'
};

const PROVIDER_ID_HINTS = {
  tencent: '从腾讯文档 URL 中获取',
  feishu: '从飞书表格 URL 中获取（如 https://xxx.feishu.cn/sheets/{token}）',
  jinshan: '从金山文档 URL 中获取'
};

/**
 * 根据文档配置获取适配器
 */
function getAdapter(doc) {
  const provider = doc.provider || 'tencent';
  return PROVIDERS[provider] || tencentDocs;
}

/**
 * 根据提供商获取对应的配置对象
 */
function getProviderConfig(config, doc) {
  const provider = (doc && doc.provider) || 'tencent';
  switch (provider) {
    case 'feishu': return config.feishuDocs || { appId: '', appSecret: '' };
    case 'jinshan': return config.jinshanDocs || { appId: '', appKey: '', accessToken: '' };
    default: return config.tencentDocs || { apiKey: '', mcpUrl: 'https://docs.qq.com/openapi/mcp' };
  }
}

/**
 * 获取数据（通用入口）
 */
async function fetchData(doc, config, cacheTTL) {
  const adapter = getAdapter(doc);
  const providerConfig = getProviderConfig(config, doc);
  return shared.fetchData(adapter, doc, providerConfig, cacheTTL);
}

/**
 * 搜索记录
 */
function searchRecords(records, query) {
  return shared.searchRecords(records, query);
}

/**
 * 解析 CSV 行
 */
function parseCsvLine(line) {
  return shared.parseCsvLine(line);
}

/**
 * 解析 CSV 为记录数组
 */
function parseSheetCsv(csvText, sheetName) {
  return shared.parseSheetCsv(csvText, sheetName);
}

/**
 * 获取文档状态
 */
function getDocState(doc, fileId) {
  return getAdapter(doc).getDocState(fileId);
}

/**
 * 清除缓存
 */
function clearCache(doc, fileId) {
  getAdapter(doc).clearCache(fileId);
}

/**
 * 获取工作表列表
 */
async function getSheetList(doc, config, state, fileId) {
  const adapter = getAdapter(doc);
  const providerConfig = getProviderConfig(config, doc);
  return adapter.getSheetList(providerConfig, state, fileId);
}

/**
 * 读取工作表 CSV
 */
async function readSheetCsv(doc, config, state, fileId, sheetId, rowCount, colCount, startRow) {
  const adapter = getAdapter(doc);
  const providerConfig = getProviderConfig(config, doc);
  return adapter.readSheetCsv(providerConfig, state, fileId, sheetId, rowCount, colCount, startRow || 0);
}

/**
 * 写入行
 */
async function writeRow(doc, config, fileId, sheetId, startRow, values) {
  const adapter = getAdapter(doc);
  const providerConfig = getProviderConfig(config, doc);
  return adapter.writeRow(providerConfig, fileId, sheetId, startRow, values);
}

module.exports = {
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_ID_LABELS,
  PROVIDER_ID_HINTS,
  getAdapter,
  getProviderConfig,
  fetchData,
  searchRecords,
  parseCsvLine,
  parseSheetCsv,
  getDocState,
  clearCache,
  getSheetList,
  readSheetCsv,
  writeRow
};
