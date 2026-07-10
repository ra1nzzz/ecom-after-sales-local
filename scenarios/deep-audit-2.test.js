/**
 * deep-audit-2.test.js - 审计 automation.js + extractAndPrepare 全链路
 * 测试实际生产代码中的状态管理、边界条件、并发安全
 *
 * 注意：automation 模块是单例，init 会自动启动引擎并读取真实 state 文件。
 * 每个测试前需要 stop() 确保干净状态。
 */

const { test, assert, createStandardConfig, STANDARD_HEADERS, sleep } = require('./helpers');
const automation = require('../src/automation');

// 每个测试前确保引擎停止
function setup() {
  automation.stop();
}

test('审计A1: init 后引擎状态正确', () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  const status = automation.getStatus();
  assert.strictEqual(status.running, false, 'enabled=false 时引擎不应自动启动');
  automation.stop();
});

test('审计A2: start/stop 正确切换 running 状态', () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  const started = automation.start(config);
  assert.strictEqual(started, true, 'start 应返回 true');
  assert.strictEqual(automation.getStatus().running, true, '引擎应运行中');
  automation.stop();
  assert.strictEqual(automation.getStatus().running, false, 'stop 后引擎应停止');
});

test('审计A3: 重复 start 应返回 false', () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  automation.start(config);
  const second = automation.start(config);
  assert.strictEqual(second, false, '重复 start 应返回 false');
  automation.stop();
});

test('审计A4: updateConfig 不应崩溃（即使引擎未运行）', () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  automation.updateConfig(config);
  const status = automation.getStatus();
  assert.strictEqual(status.running, false, 'updateConfig 不应启动引擎');
  automation.stop();
});

test('审计A5: rejectMessage 不存在的ID → 应返回失败', async () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  const result = await automation.rejectMessage(99999);
  assert.ok(!result.success, '拒绝不存在的消息应返回失败');
  assert.ok(result.error, '应包含错误信息');
  automation.stop();
});

test('审计A6: approveMessage 不存在的ID → 应返回失败', async () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  const result = await automation.approveMessage(99999, null);
  assert.ok(!result.success, '审核不存在的消息应返回失败');
  automation.stop();
});

// ========== shutdown 安全性 ==========

test('审计A7: shutdown 在引擎未运行时不应崩溃', async () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  await automation.shutdown();
  assert.strictEqual(automation.getStatus().running, false, 'shutdown 后引擎应停止');
});

test('审计A8: shutdown 在引擎运行时应正确停止', async () => {
  setup();
  const config = createStandardConfig({
    guanchen: { apiKey: 'test', baseUrl: 'http://127.0.0.1:59999', enabled: false,
      keyword: '理赔', requireDigits: true, searchInterval: 60000,
      targetDocId: 'doc_test', targetId: 'target0', autoConfirm: true }
  });
  automation.init(config);
  automation.start(config);
  assert.strictEqual(automation.getStatus().running, true);
  await automation.shutdown();
  assert.strictEqual(automation.getStatus().running, false, 'shutdown 后应停止');
});

// ========== extractAndPrepare 边界测试 ==========

test('审计A9: extractAndPrepare 空描述 → 应返回失败', async () => {
  const { extractAndPrepare } = require('../src/write-pipeline');
  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = doc.writeTargets[0];
  const headersInfo = { success: true, headers: STANDARD_HEADERS, allLines: [], sheet: { sheet_id: 's1' }, targetFileId: 'f1' };
  const result = await extractAndPrepare(config, doc, target, '', headersInfo, [STANDARD_HEADERS]);
  assert.ok(!result.success, '空描述应返回失败');
  assert.ok(result.error, '应包含错误信息');
});

test('审计A10: extractAndPrepare 超长描述(>5000字符) → 应返回失败', async () => {
  const { extractAndPrepare } = require('../src/write-pipeline');
  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = doc.writeTargets[0];
  const headersInfo = { success: true, headers: STANDARD_HEADERS, allLines: [], sheet: { sheet_id: 's1' }, targetFileId: 'f1' };
  const longDesc = 'A'.repeat(5001);
  const result = await extractAndPrepare(config, doc, target, longDesc, headersInfo, [STANDARD_HEADERS]);
  assert.ok(!result.success, '超长描述应返回失败');
  assert.ok(result.error.includes('过长'), `错误应包含'过长'，实际: ${result.error}`);
});

test('审计A11: extractAndPrepare headersInfo.success=false → 应返回失败不崩溃', async () => {
  const { extractAndPrepare } = require('../src/write-pipeline');
  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = doc.writeTargets[0];
  const headersInfo = { success: false, error: '读取表头失败: TLS connection error' };
  const result = await extractAndPrepare(config, doc, target, '测试描述', headersInfo, null);
  assert.ok(!result.success, 'headersInfo 失败时应返回失败');
  assert.ok(result.error.includes('表头') || result.error.includes('TLS'),
    `错误应包含表头/TLS相关信息，实际: ${result.error}`);
});

test('审计A12: extractAndPrepare headersInfo=null → 应返回失败不崩溃', async () => {
  const { extractAndPrepare } = require('../src/write-pipeline');
  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = doc.writeTargets[0];
  const result = await extractAndPrepare(config, doc, target, '测试描述', null, null);
  assert.ok(!result.success, 'headersInfo=null 时应返回失败');
  assert.ok(result.error.includes('缺失') || result.error.includes('表头'),
    `错误应包含缺失/表头，实际: ${result.error}`);
});
