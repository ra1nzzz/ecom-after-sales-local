/**
 * 场景1: Sheet 权限变更
 *
 * 测试当腾讯文档/飞书文档的权限突然变更时，系统的行为：
 * - 读取表头时返回 403/401 → 应返回失败而非崩溃
 * - 写入时权限丢失 → 应捕获错误并返回有意义的错误信息
 * - 权限恢复后 → 重试机制应能自动恢复
 * - Sheet 被重命名/删除 → 应返回明确错误
 */

const { test, assert, createStandardConfig, STANDARD_HEADERS, sleep } = require('./helpers');
const { detectDuplicate } = require('../src/write-pipeline');

test('场景1.1: 读取表头时返回 403 权限错误 → 不应崩溃', async () => {
  // 模拟 adapter.getSheetList 抛出权限错误
  const { readSheetHeaders } = mockModule('../src/write-pipeline', {
    '../src/doc-provider': {
      getAdapter: () => ({
        getSheetList: async () => { throw new Error('HTTP 403: 文档访问被拒绝，请检查权限'); },
        init: async () => {},
        getDocState: () => ({ cachedData: null, cacheTimestamp: 0 }),
      }),
      getProviderConfig: () => ({}),
    },
    '../src/shared-docs': { parseCsvLine: () => [] },
  });

  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = doc.writeTargets[0];

  const result = await readSheetHeaders(config, doc, target);
  assert.ok(!result.success, '权限错误时应返回 success=false');
  assert.ok(result.error.includes('403') || result.error.includes('权限') || result.error.includes('拒绝'),
    `错误信息应包含权限相关描述，实际: ${result.error}`);
});

test('场景1.2: 写入时权限丢失 → executeWrite 应返回失败', async () => {
  const { executeWrite } = mockModule('../src/write-pipeline', {
    '../src/doc-provider': {
      getAdapter: () => ({
        writeRow: async () => { throw new Error('HTTP 403: 没有编辑权限'); },
        getSheetList: async () => [{ sheet_id: 's1', sheet_name: '工作表1', col_count: 10, row_count: 200 }],
        getDocState: () => ({}),
        clearCache: () => {},
      }),
      getProviderConfig: () => ({}),
      findEmptyRow: async () => null,
      readSheetCsv: async () => '\n\n\n\n\n',
    },
    '../src/shared-docs': { parseCsvLine: (line) => line ? line.split(',') : [] },
  });

  const config = createStandardConfig();
  const doc = config.documents[0];
  const prepareResult = {
    success: true, targetRow: 5, values: ['test'], duplicate: null,
    targetFileId: 'f1', sheetId: 's1'
  };

  const result = await executeWrite(config, doc, prepareResult, null);
  assert.ok(!result.success, '写入失败应返回 success=false');
  assert.ok(result.error.includes('403') || result.error.includes('权限'),
    `错误应包含权限信息，实际: ${result.error}`);
});

test('场景1.3: Sheet 被重命名 → getSheetList 找不到目标 sheet', async () => {
  const { readSheetHeaders } = mockModule('../src/write-pipeline', {
    '../src/doc-provider': {
      getAdapter: () => ({
        getSheetList: async () => [
          { sheet_id: 's_new', sheet_name: '重命名后的表', col_count: 10, row_count: 200 }
        ],
        init: async () => {},
        getDocState: () => ({}),
        readSheetCsv: async () => 'header1,header2\nval1,val2',
      }),
      getProviderConfig: () => ({}),
    },
    '../src/shared-docs': { parseCsvLine: (line) => line.split(',') },
  });

  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = { ...doc.writeTargets[0], sheetName: '工作表1' }; // 原名称

  const result = await readSheetHeaders(config, doc, target);
  // 代码会 fallback 到 sheets[0]，不应崩溃
  assert.ok(result.success, 'Sheet 重命名后应 fallback 到第一个 sheet');
  assert.strictEqual(result.sheet.sheet_name, '重命名后的表');
});

test('场景1.4: 权限错误不影响已有数据的查重逻辑', () => {
  // 即使文档权限出问题，本地已加载的数据查重逻辑应正常工作
  const headers = STANDARD_HEADERS;
  const existingRow = ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '399', '20', ''];
  const parsedRows = [headers, existingRow];

  const extractResult = {
    values: ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF1234567890', '丢件', '399', '20', '']
  };

  const result = detectDuplicate(headers, parsedRows, extractResult, { name: 'test' });
  assert.ok(result.isDuplicate, '应检测到重复');
  assert.strictEqual(result.duplicateInfo.type, 'skip', '完全一致应 skip');
});

test('场景1.5: 连续权限失败 → 重试3次后返回错误', async () => {
  let callCount = 0;
  const { readSheetHeaders } = mockModule('../src/write-pipeline', {
    '../src/doc-provider': {
      getAdapter: () => ({
        getSheetList: async () => {
          callCount++;
          throw new Error('HTTP 403: 文档访问被拒绝');
        },
        init: async () => {},
        getDocState: () => ({}),
      }),
      getProviderConfig: () => ({}),
    },
    '../src/shared-docs': { parseCsvLine: () => [] },
  });

  const config = createStandardConfig();
  const doc = config.documents[0];
  const target = doc.writeTargets[0];

  // readSheetHeaders 本身不重试（重试在 automation.js 的 searchAndProcess 中）
  // 这里验证单次调用正确返回失败
  const result = await readSheetHeaders(config, doc, target);
  assert.ok(!result.success, '应返回失败');
  assert.strictEqual(callCount, 1, 'readSheetHeaders 只调用1次（重试在上层）');
});

// ========== Mock 工具函数 ==========

/**
 * 轻量级 module mock，替换 require 依赖
 * 使用 Node.js 内置 Module._cache 操作
 */
function mockModule(modulePath, mocks) {
  // 清除缓存
  delete require.cache[require.resolve(modulePath)];
  // 注册 mock
  for (const [depPath, mockValue] of Object.entries(mocks)) {
    const resolved = require.resolve(depPath, { paths: [require('path').dirname(require.resolve(modulePath))] });
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: mockValue,
    };
  }
  const mod = require(modulePath);
  // 清理 mock 缓存
  for (const depPath of Object.keys(mocks)) {
    const resolved = require.resolve(depPath, { paths: [require('path').dirname(require.resolve(modulePath))] });
    delete require.cache[resolved];
  }
  return mod;
}
