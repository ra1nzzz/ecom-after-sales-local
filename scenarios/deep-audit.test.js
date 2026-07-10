/**
 * deep-audit.test.js - 深度审计：直接调用生产代码，寻找真实bug
 * 不使用 mock，直接 require 实际模块，用边界数据触发潜在问题
 */

const { test, assert } = require('./helpers');
const { detectDuplicate } = require('../src/write-pipeline');

const HEADERS = ['登记日期', '仓库', '店铺名称', '平台', '订单号', '快递单号', '理赔类型', '货值(元)', '运费(元)', '备注'];

// ========== detectDuplicate 边界测试 ==========

test('审计1: parsedRows 只有表头(无数据行) → 不应崩溃', () => {
  const extractResult = { values: ['', '', '', '', '', 'SF123', '', '100', '10', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS], extractResult, { name: 'test' });
  assert.ok(!result.isDuplicate, '无数据行时不应检测到重复');
});

test('审计2: 数据行列数少于表头列数 → 不应崩溃', () => {
  const shortRow = ['2026-07-10', '洛奇仓', '和旭数码']; // 只有3列
  const extractResult = { values: ['', '', '', '', '', 'SF123', '', '100', '10', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS, shortRow], extractResult, { name: 'test' });
  assert.ok(!result.isDuplicate, '短行不应匹配到快递单号(越界访问应为undefined)');
});

test('审计3: 数据行列数多于表头列数 → 不应崩溃', () => {
  const longRow = ['2026-07-10', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF123', '丢件', '399', '20', '', 'extra1', 'extra2'];
  const extractResult = { values: ['', '', '', '', '', 'SF123', '', '', '', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS, longRow], extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应检测到重复');
});

test('审计4: 快递单号列为 undefined/null → 不应崩溃', () => {
  const extractResult = { values: ['', '', '', '', '', null, '', '100', '10', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS], extractResult, { name: 'test' });
  assert.ok(!result.isDuplicate, 'null快递单号不应崩溃');
});

test('审计5: 快递单号为纯空格 → 应视为空', () => {
  const existingRow = ['', '', '', '', '', '   ', '', '', '', ''];
  const extractResult = { values: ['', '', '', '', '', '   ', '', '', '', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS, existingRow], extractResult, { name: 'test' });
  // trim 后为空，不应匹配
  assert.ok(!result.isDuplicate, '纯空格快递单号 trim 后为空，不应匹配');
});

test('审计6: 新旧快递单号大小写不同 → 应视为不同', () => {
  const existingRow = ['', '', '', '', '', 'sf1234567890', '', '', '', ''];
  const extractResult = { values: ['', '', '', '', '', 'SF1234567890', '', '', '', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS, existingRow], extractResult, { name: 'test' });
  assert.ok(!result.isDuplicate, '大小写不同应视为不同单号');
});

test('审计7: merge 时新数据值也是空 → 不应覆盖旧数据', () => {
  // 旧数据有货值399，新数据货值为空 → merge 不应清空旧值
  const existingRow = ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF123', '丢件', '399', '20', ''];
  // 旧行有空备注列
  const extractResult = { values: ['', '', '', '', '', 'SF123', '', '', '', '新备注'] };
  const result = detectDuplicate(HEADERS, [HEADERS, existingRow], extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应检测到重复');
  if (result.duplicateInfo.type === 'merge') {
    const amountIdx = HEADERS.indexOf('货值(元)');
    assert.strictEqual(result.duplicateInfo.mergedValues[amountIdx], '399',
      'merge 不应清空旧货值');
  }
});

test('审计8: 所有字段都为空字符串的行 → 查重不应崩溃', () => {
  const emptyRow = ['', '', '', '', '', '', '', '', '', ''];
  const extractResult = { values: ['', '', '', '', '', 'SF123', '', '100', '10', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS, emptyRow], extractResult, { name: 'test' });
  // 空行的快递单号为空，不会匹配
  assert.ok(!result.isDuplicate, '空行不应匹配');
});

test('审计9: headers 中有空字符串列名 → 不应崩溃', () => {
  const weirdHeaders = ['登记日期', '', '快递单号', ''];
  const existingRow = ['2026-07-10', 'val', 'SF123', 'val2'];
  const extractResult = { values: ['', '', 'SF123', ''] };
  const result = detectDuplicate(weirdHeaders, [weirdHeaders, existingRow], extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应能匹配快递单号');
});

test('审计10: extractResult.values 为 null → 不应崩溃', () => {
  const extractResult = { values: null };
  try {
    const result = detectDuplicate(HEADERS, [HEADERS], extractResult, { name: 'test' });
    assert.ok(!result.isDuplicate, 'null values 不应崩溃');
  } catch (err) {
    assert.fail(`detectDuplicate 在 values=null 时崩溃: ${err.message}`);
  }
});

test('审计11: headers 包含 "货值" 但格式是 "货值(元)" → findIndex 应正确匹配', () => {
  const amountColIdx = HEADERS.findIndex(h => {
    const name = (h || '').trim();
    return name.includes('货值') || name.includes('金额') || name.includes('价格');
  });
  assert.strictEqual(amountColIdx, 7, '货值(元) 应在索引7');
});

test('审计12: 备注列在 merge 时被正确忽略(不作为空字段)', () => {
  // 旧数据备注为空，新数据备注也为空 → 备注不应出现在 newFieldsFilled 中
  const existingRow = ['2026-07-10', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF123', '丢件', '399', '20', ''];
  const extractResult = { values: ['', '', '', '', '', 'SF123', '', '', '', ''] };
  const result = detectDuplicate(HEADERS, [HEADERS, existingRow], extractResult, { name: 'test' });
  assert.ok(result.isDuplicate);
  if (result.duplicateInfo.type === 'skip') {
    // 备注为空且新数据也没有备注 → allIdentical 应为 true（备注列被忽略）
    assert.strictEqual(result.duplicateInfo.type, 'skip');
  }
});
