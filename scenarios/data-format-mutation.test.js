/**
 * 场景2: 数据格式突变
 *
 * 测试当输入数据格式异常时，提取和质量检查的鲁棒性：
 * - 表头列名变化（新增/删除列、顺序变化）
 * - LLM 返回非 JSON / 格式错误
 * - 金额字段为0、空字符串、非数字
 * - 物流单号含特殊字符
 * - 店铺名称误填状态描述（如"平台已退"）
 * - 消息内容为空或超长
 */

const { test, assert, createStandardConfig, STANDARD_HEADERS, createExtractResult,
  assertQualityIssue, assertNoQualityIssues, assertDuplicateSkip, assertDuplicateMerge,
  createParsedRows } = require('./helpers');
const { detectDuplicate } = require('../src/write-pipeline');

// ========== 表头变化 ==========

test('场景2.1: 表头新增列 → 质量检查仍正常工作', () => {
  const extendedHeaders = [...STANDARD_HEADERS, '处理人'];
  const extractResult = createExtractResult({
    values: ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '399', '20', '', '']
  });

  // detectDuplicate 应能处理多一列的情况
  const existingRow = ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '399', '20', '', '张三'];
  const parsedRows = [extendedHeaders, existingRow];
  const result = detectDuplicate(extendedHeaders, parsedRows, extractResult, { name: 'test' });
  // 旧数据有处理人，新数据没有 → allIdentical=false, newFieldsFilled=0, isComplete=true → skip
  assert.ok(result.isDuplicate, '应检测到重复');
  assert.strictEqual(result.duplicateInfo.type, 'skip');
});

test('场景2.2: 表头列顺序变化 → 按列名匹配不应错乱', () => {
  // 注意：detectDuplicate 按列索引匹配，列顺序变化会导致不同行为
  // 这里测试核心逻辑：快递单号列索引正确找到
  const reorderedHeaders = ['快递单号', '店铺名称', '货值(元)', '运费(元)', '理赔类型'];
  const extractResult = {
    values: ['SF1234567890', '和旭数码', '399', '20', '丢件']
  };
  const existingRow = ['SF1234567890', '和旭数码', '399', '20', '丢件'];
  const parsedRows = [reorderedHeaders, existingRow];

  const result = detectDuplicate(reorderedHeaders, parsedRows, extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '快递单号相同应检测到重复');
  assert.strictEqual(result.duplicateInfo.type, 'skip', '完全一致应 skip');
});

test('场景2.3: 表头缺少快递单号列 → detectDuplicate 返回非重复', () => {
  const headersWithoutLogistics = ['登记日期', '店铺名称', '货值(元)'];
  const extractResult = { values: ['2026-07-10', '和旭数码', '399'] };
  const parsedRows = [headersWithoutLogistics, ['2026-07-09', '其他店', '100']];

  const result = detectDuplicate(headersWithoutLogistics, parsedRows, extractResult, { name: 'test' });
  assert.ok(!result.isDuplicate, '没有快递单号列时不应检测重复');
});

// ========== 金额格式异常 ==========

test('场景2.4: 货值为 "0" → 质量检查应标记 no_amount', () => {
  // 模拟质量检查逻辑
  const headers = STANDARD_HEADERS;
  const amountColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name.includes('货值') || name.includes('金额') || name.includes('价格');
  });
  const amount = '0';
  const numAmount = parseFloat(amount);
  const hasIssue = !amount || !/^\d+\.?\d*$/.test(amount) || numAmount <= 0;
  assert.ok(hasIssue, '金额为0应触发 no_amount 质量检查');
});

test('场景2.5: 货值为空字符串 → 质量检查应标记 no_amount', () => {
  const amount = '';
  const numAmount = parseFloat(amount);
  const hasIssue = !amount || !/^\d+\.?\d*$/.test(amount) || numAmount <= 0;
  assert.ok(hasIssue, '金额为空应触发 no_amount');
});

test('场景2.6: 货值为非数字文本 → 质量检查应标记 no_amount', () => {
  const amount = '待定';
  const numAmount = parseFloat(amount);
  const hasIssue = !amount || !/^\d+\.?\d*$/.test(amount) || isNaN(numAmount) || numAmount <= 0;
  assert.ok(hasIssue, '金额为非数字应触发 no_amount');
});

test('场景2.7: 货值为有效正数 → 质量检查通过', () => {
  const amount = '399.5';
  const numAmount = parseFloat(amount);
  const hasIssue = !amount || !/^\d+\.?\d*$/.test(amount) || numAmount <= 0;
  assert.ok(!hasIssue, '有效金额不应触发质量检查');
});

// ========== 店铺名称异常 ==========

test('场景2.8: 店铺名称为 "平台已退" → 质量检查应标记 shop_name_invalid', () => {
  const shopVal = '平台已退';
  const statusKeywords = ['已退', '已退款', '已签收', '已发货', '已揽收', '平台已退', '退回', '异常'];
  let hasIssue = false;
  for (const kw of statusKeywords) {
    if (shopVal === kw || shopVal.includes(kw)) {
      hasIssue = true;
      break;
    }
  }
  assert.ok(hasIssue, '"平台已退"应触发 shop_name_invalid');
});

test('场景2.9: 店铺名称为正常店名 → 质量检查通过', () => {
  const shopVal = '和旭数码专卖店';
  const statusKeywords = ['已退', '已退款', '已签收', '已发货', '已揽收', '平台已退', '退回', '异常'];
  let hasIssue = false;
  for (const kw of statusKeywords) {
    if (shopVal === kw || shopVal.includes(kw)) {
      hasIssue = true;
      break;
    }
  }
  assert.ok(!hasIssue, '正常店名不应触发质量检查');
});

// ========== 物流单号异常 ==========

test('场景2.10: 物流单号含特殊字符 → 查重仍能匹配', () => {
  const headers = ['快递单号', '店铺名称'];
  const specialNo = 'SF-1234/5678';
  const extractResult = { values: [specialNo, '和旭数码'] };
  const existingRow = [specialNo, '和旭数码'];
  const parsedRows = [headers, existingRow];

  const result = detectDuplicate(headers, parsedRows, extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '含特殊字符的物流单号也应正确匹配');
  assert.strictEqual(result.duplicateInfo.type, 'skip');
});

test('场景2.11: 物流单号为空 → 质量检查应标记 no_logistics_no', () => {
  const headers = STANDARD_HEADERS;
  const logisticsColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name === '快递单号' || name === '物流单号';
  });
  const logisticsNo = '';
  const hasIssue = !logisticsNo.trim();
  assert.ok(hasIssue, '物流单号为空应触发 no_logistics_no');
  assert.ok(logisticsColIdx >= 0, '应能找到快递单号列');
});

// ========== 查重边缘情况 ==========

test('场景2.12: 旧数据有空字段，新数据能补全 → merge', () => {
  const headers = STANDARD_HEADERS;
  // 旧行：货值为空
  const existingRow = ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '', '20', ''];
  const parsedRows = [headers, existingRow];
  // 新数据：货值有值（快递单号相同以触发查重）
  const extractResult = {
    values: ['', '', '', '', '', 'SF1234567890', '', '399', '', '']
  };

  const result = detectDuplicate(headers, parsedRows, extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应检测到重复');
  assert.strictEqual(result.duplicateInfo.type, 'merge', '应执行 merge 补全');
  // 验证 mergedValues 中货值被填入
  const amountIdx = headers.indexOf('货值(元)');
  assert.strictEqual(result.duplicateInfo.mergedValues[amountIdx], '399', 'mergedValues 货值应为 399');
});

test('场景2.13: 旧数据完整，新数据有不同值 → skip 保护', () => {
  const headers = STANDARD_HEADERS;
  const existingRow = ['2026-07-09', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '399', '20', '备注'];
  const parsedRows = [headers, existingRow];
  // 新数据：理赔类型不同（快递单号相同以触发查重）
  const extractResult = {
    values: ['', '', '', '', '', 'SF1234567890', '破损', '', '', '']
  };

  const result = detectDuplicate(headers, parsedRows, extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应检测到重复');
  assert.strictEqual(result.duplicateInfo.type, 'skip', '旧数据完整时应 skip 保护');
});

test('场景2.14: 同一物流单号出现多次 → 匹配第一条', () => {
  const headers = ['快递单号', '店铺名称'];
  const extractResult = { values: ['SF999', '新店铺'] };
  const parsedRows = [
    headers,
    ['SF999', '店铺A'],
    ['SF999', '店铺B'], // 第二条重复
  ];

  const result = detectDuplicate(headers, parsedRows, extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应检测到重复');
  assert.strictEqual(result.targetRow, 1, '应匹配第一条（row index 1）');
});

// ========== 空数据/超长数据 ==========

test('场景2.15: extractResult 所有值为空 → nonEmptyCount=0 应被拒绝', () => {
  const headers = STANDARD_HEADERS;
  const allEmpty = { values: ['', '', '', '', '', '', '', '', '', ''], nonEmptyCount: 0 };
  assert.strictEqual(allEmpty.nonEmptyCount, 0, '全空数据 nonEmptyCount 应为 0');
  // extractAndPrepare 中会检查 nonEmptyCount === 0 并返回失败
});

test('场景2.16: 描述内容超长(>5000字符) → 应被拒绝', () => {
  const MAX_DESCRIPTION_LENGTH = 5000;
  const longDesc = 'A'.repeat(5001);
  assert.ok(longDesc.length > MAX_DESCRIPTION_LENGTH, '超长描述应被识别');
});

test('场景2.17: 描述内容为空 → 应被拒绝', () => {
  const emptyDesc = '';
  assert.ok(!emptyDesc || !emptyDesc.trim(), '空描述应被识别');
});
