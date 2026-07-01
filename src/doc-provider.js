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

// 适配器元数据：数据驱动的配置掩码/校验/标签
const ADAPTER_META = {
  tencent: { configKey: 'tencentDocs', label: '腾讯文档', sensitiveFields: ['apiKey'], requiredFields: ['apiKey'], idLabel: 'File ID', idHint: '从腾讯文档URL中获取' },
  feishu: { configKey: 'feishuDocs', label: '飞书', sensitiveFields: ['appSecret'], requiredFields: ['appId'], idLabel: 'Spreadsheet Token', idHint: '从飞书表格URL获取' },
  jinshan: { configKey: 'jinshanDocs', label: '金山文档', sensitiveFields: ['appKey', 'accessToken'], requiredFields: ['accessToken'], idLabel: 'File ID', idHint: '从金山文档URL中获取' }
};

// 向后兼容：从 ADAPTER_META 派生
const PROVIDER_LABELS = Object.fromEntries(Object.entries(ADAPTER_META).map(([k, v]) => [k, v.label]));
const PROVIDER_ID_LABELS = Object.fromEntries(Object.entries(ADAPTER_META).map(([k, v]) => [k, v.idLabel]));
const PROVIDER_ID_HINTS = Object.fromEntries(Object.entries(ADAPTER_META).map(([k, v]) => [k, v.idHint]));

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
  const meta = ADAPTER_META[provider] || ADAPTER_META.tencent;
  return config[meta.configKey] || {};
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
 * 初始化适配器（如获取访问令牌）
 */
async function init(doc, config, state) {
  const adapter = getAdapter(doc);
  const providerConfig = getProviderConfig(config, doc);
  if (adapter.init) await adapter.init(providerConfig, state);
}

/**
 * 写入行
 */
async function writeRow(doc, config, state, fileId, sheetId, startRow, values) {
  const adapter = getAdapter(doc);
  const providerConfig = getProviderConfig(config, doc);
  return adapter.writeRow(providerConfig, state, fileId, sheetId, startRow, values);
}

/**
 * 查找下一个空行
 * 如果适配器自带 findEmptyRow 则使用它（如金山的内存扫描），否则返回 null 由调用方走默认批次逻辑
 */
async function findEmptyRow(doc, config, state, fileId, sheetId, startRow, colCount, maxRowCount) {
  const adapter = getAdapter(doc);
  if (!adapter.findEmptyRow) return null;
  const providerConfig = getProviderConfig(config, doc);
  return adapter.findEmptyRow(providerConfig, state, fileId, sheetId, startRow, colCount, maxRowCount);
}

module.exports = {
  PROVIDERS,
  ADAPTER_META,
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
  init,
  writeRow,
  findEmptyRow
};
