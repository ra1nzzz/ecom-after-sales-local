/**
 * helpers.js - 测试场景共享工具
 * 提供 mock 工厂、断言辅助、伪造数据生成
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ========== Mock 工厂 ==========

/**
 * 创建 mock 的 doc-provider adapter
 */
function createMockAdapter(overrides = {}) {
  const defaults = {
    getSheetList: async () => [{
      sheet_id: 'sheet001',
      sheet_name: '工作表1',
      col_count: 10,
      row_count: 200
    }],
    readSheetCsv: async () => '',
    writeRow: async () => ({ updateNum: 1 }),
    init: async () => {},
    getDocState: () => ({
      cachedData: null,
      cacheTimestamp: 0,
      cacheLoading: false,
      loadingPromise: null
    }),
    clearCache: () => {}
  };
  return { ...defaults, ...overrides };
}

/**
 * 创建 mock 的 guanchen API 响应
 */
function createMockGuanchenResponse(messages = []) {
  return {
    total: messages.length,
    limit: 200,
    offset: 0,
    messages: messages.map((m, i) => ({
      id: m.id || (1000 + i),
      content: m.content || '',
      msg_time: m.msg_time || Math.floor(Date.now() / 1000) - i * 60,
      sender: m.sender || '测试用户',
      chat_name: m.chat_name || '售后理赔群'
    }))
  };
}

/**
 * 创建标准表头配置
 */
function createStandardConfig(overrides = {}) {
  return {
    documents: [{
      id: 'doc_test',
      name: '快递理赔登记表',
      fileId: 'test_file_001',
      readSheetKeywords: ['理赔', '快递'],
      writeTargets: [{
        id: 'target0',
        name: '快递理赔登记表',
        sheetName: '工作表1'
      }]
    }],
    tencentDocs: { apiKey: 'test_key', mcpUrl: 'https://docs.qq.com/openapi/mcp' },
    llm: { provider: 'ollama', apiKey: 'test_key', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
    wangdian: { sid: 'test', key: 'test', secret: 'test', salt: 'test' },
    guanchen: {
      apiKey: 'test_key',
      baseUrl: 'http://127.0.0.1:8742',
      enabled: true,
      keyword: '理赔',
      requireDigits: true,
      searchInterval: 60000,
      targetDocId: 'doc_test',
      targetId: 'target0',
      autoConfirm: true
    },
    ...overrides
  };
}

/**
 * 创建标准理赔表头
 */
const STANDARD_HEADERS = [
  '登记日期', '仓库', '店铺名称', '平台', '订单号',
  '快递单号', '理赔类型', '货值(元)', '运费(元)', '备注'
];

/**
 * 创建模拟的提取结果
 */
function createExtractResult(overrides = {}) {
  return {
    success: true,
    method: 'llm',
    values: ['', '洛奇-电商仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '399', '20', ''],
    missing: [],
    nonEmptyCount: 7,
    ...overrides
  };
}

/**
 * 创建模拟的 parsedRows（包含表头+数据行）
 */
function createParsedRows(headers, dataRows) {
  return [headers, ...dataRows];
}

// ========== 断言辅助 ==========

/**
 * 断言质量检查包含指定问题
 */
function assertQualityIssue(result, issue) {
  assert.ok(result.qualityIssues, '结果应包含 qualityIssues 数组');
  assert.ok(
    result.qualityIssues.includes(issue),
    `质量检查应包含 "${issue}"，实际: ${JSON.stringify(result.qualityIssues)}`
  );
}

/**
 * 断言质量检查通过（无问题）
 */
function assertNoQualityIssues(result) {
  assert.ok(
    !result.qualityIssues || result.qualityIssues.length === 0,
    `不应有质量问题，实际: ${JSON.stringify(result.qualityIssues)}`
  );
}

/**
 * 断言查重结果是 skip 类型
 */
function assertDuplicateSkip(result, reason) {
  assert.ok(result.duplicate, '应有查重结果');
  assert.strictEqual(result.duplicate.type, 'skip', `查重类型应为 skip，实际: ${result.duplicate.type}`);
  if (reason) {
    assert.ok(result.skipped, '应有 skipped 标记');
    assert.strictEqual(result.skipReason, reason, `跳过原因应为 ${reason}`);
  }
}

/**
 * 断言查重结果是 merge 类型
 */
function assertDuplicateMerge(result) {
  assert.ok(result.duplicate, '应有查重结果');
  assert.strictEqual(result.duplicate.type, 'merge', `查重类型应为 merge，实际: ${result.duplicate.type}`);
  assert.ok(result.duplicate.mergedValues, 'merge 结果应包含 mergedValues');
  assert.ok(result.duplicate.filledFields, 'merge 结果应包含 filledFields');
}

/**
 * 断言操作在指定毫秒内完成
 */
async function assertCompletesWithin(fn, maxMs, label = '操作') {
  const start = Date.now();
  await fn();
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed <= maxMs,
    `${label}应在 ${maxMs}ms 内完成，实际耗时 ${elapsed}ms`
  );
}

/**
 * 断言操作在指定毫秒后仍未完成（用于测试超时）
 */
async function assertDoesNotCompleteWithin(fn, minMs, label = '操作') {
  let completed = false;
  const promise = fn().then(() => { completed = true; });
  await new Promise(r => setTimeout(r, minMs));
  assert.ok(!completed, `${label}不应在 ${minMs}ms 内完成`);
}

// ========== 延时工具 ==========

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ========== 导出 ==========

module.exports = {
  test,
  assert,
  createMockAdapter,
  createMockGuanchenResponse,
  createStandardConfig,
  STANDARD_HEADERS,
  createExtractResult,
  createParsedRows,
  assertQualityIssue,
  assertNoQualityIssues,
  assertDuplicateSkip,
  assertDuplicateMerge,
  assertCompletesWithin,
  assertDoesNotCompleteWithin,
  sleep
};
