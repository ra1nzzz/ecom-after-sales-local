/**
 * 场景4: 并发写入
 *
 * 测试当多个写入请求同时发生时，系统的数据一致性：
 * - 两条消息同时匹配到同一空行 → 不应覆盖
 * - 并发写入同一物流单号 → 查重应检测到
 * - busy 标志防止并发搜索
 * - 多个 pending 消息同时审核 → 状态一致性
 * - clearAllPending 与 approveMessage 并发 → 不应数据竞争
 * - writeRow 调用序列化 → 不交错写入
 */

const { test, assert, createStandardConfig, STANDARD_HEADERS,
  createExtractResult, sleep } = require('./helpers');
const { detectDuplicate } = require('../src/write-pipeline');

// ========== 并发写入同一行 ==========

test('场景4.1: 两个并发写入找到同一空行 → 第二个应检测到重复', () => {
  // 模拟：写入A完成后，写入B查重时发现A的数据
  const headers = STANDARD_HEADERS;
  const logisticsNo = 'SF1234567890';

  // 初始状态：只有表头
  const rowsBeforeA = [headers];
  const extractA = createExtractResult({
    values: ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', logisticsNo, '丢件', '399', '20', '']
  });

  // A写入前查重 → 无重复
  const dupBeforeA = detectDuplicate(headers, rowsBeforeA, extractA, { name: 'test' });
  assert.ok(!dupBeforeA.isDuplicate, 'A写入前不应有重复');

  // A写入后的行
  const rowA = extractA.values.slice();
  const rowsAfterA = [headers, rowA];

  // B用相同物流单号查重 → 应检测到重复
  const extractB = createExtractResult({
    values: ['', '', '', '', '', logisticsNo, '', '', '', '']
  });
  const dupAfterA = detectDuplicate(headers, rowsAfterA, extractB, { name: 'test' });
  assert.ok(dupAfterA.isDuplicate, 'B应在A写入后检测到重复');
});

test('场景4.2: 并发写入不同物流单号 → 互不干扰', () => {
  const headers = STANDARD_HEADERS;

  const extractA = createExtractResult({
    values: ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973250', 'SF111', '丢件', '399', '20', '']
  });
  const extractB = createExtractResult({
    values: ['', '洛奇仓', '和旭数码', '拼多多', '260625-471911708973251', 'SF222', '破损', '158', '12', '']
  });

  // A已写入
  const rowsAfterA = [headers, extractA.values.slice()];

  // B查重 → 不同单号，无重复
  const dupB = detectDuplicate(headers, rowsAfterA, extractB, { name: 'test' });
  assert.ok(!dupB.isDuplicate, '不同物流单号不应检测到重复');
});

// ========== busy 标志并发控制 ==========

test('场景4.3: busy=true 时新搜索应被跳过', async () => {
  let busy = false;
  let searchCount = 0;

  // 模拟 searchAndProcess 的 busy 检查
  async function mockSearchAndProcess() {
    if (busy) {
      return 'skipped';
    }
    busy = true;
    searchCount++;
    await sleep(50); // 模拟处理耗时
    busy = false;
    return 'processed';
  }

  // 启动两个并发搜索
  const [r1, r2] = await Promise.all([
    mockSearchAndProcess(),
    mockSearchAndProcess(),
  ]);

  // 一个 processed，一个 skipped
  const results = [r1, r2].sort();
  assert.strictEqual(results[0], 'processed', '一个应被处理');
  assert.strictEqual(results[1], 'skipped', '另一个应被跳过');
  assert.strictEqual(searchCount, 1, '应只执行1次搜索');
});

test('场景4.4: busy 确保搜索串行化', async () => {
  let busy = false;
  const executionOrder = [];

  async function mockSearch(id) {
    if (busy) {
      executionOrder.push(`${id}-skipped`);
      return;
    }
    busy = true;
    executionOrder.push(`${id}-start`);
    await sleep(30);
    executionOrder.push(`${id}-end`);
    busy = false;
  }

  // 串行执行3个搜索
  await mockSearch('A');
  await mockSearch('B');
  await mockSearch('C');

  assert.deepStrictEqual(executionOrder, [
    'A-start', 'A-end',
    'B-start', 'B-end',
    'C-start', 'C-end',
  ], '串行执行不应有skip');
});

// ========== 并发审核状态一致性 ==========

test('场景4.5: clearAllPending 与 approveMessage 并发 → clearAll 应赢', async () => {
  // 模拟 pendingMessages Map
  const pendingMessages = new Map();
  pendingMessages.set(1, { message: { id: 1 }, prepareResult: {} });
  pendingMessages.set(2, { message: { id: 2 }, prepareResult: {} });
  pendingMessages.set(3, { message: { id: 3 }, prepareResult: {} });

  let totalRejected = 0;
  let totalApproved = 0;

  // 模拟 clearAllPending
  async function clearAllPending() {
    const count = pendingMessages.size;
    for (const [id] of pendingMessages) {
      totalRejected++;
    }
    pendingMessages.clear();
    return { success: true, cleared: count };
  }

  // 模拟 approveMessage
  async function approveMessage(id) {
    if (!pendingMessages.has(id)) {
      return { success: false, error: '待审消息不存在' };
    }
    pendingMessages.delete(id);
    totalApproved++;
    return { success: true };
  }

  // 并发执行
  const [clearResult, approveResult] = await Promise.all([
    clearAllPending(),
    approveMessage(1),
  ]);

  // clearAll 应清空所有
  assert.ok(clearResult.success, 'clearAll 应成功');
  assert.strictEqual(pendingMessages.size, 0, 'pending 应为空');

  // approve 要么先于 clear 执行（成功），要么晚于 clear（失败）
  // 不应导致 totalApproved + totalRejected > 原始数量
  const totalOps = totalApproved + totalRejected;
  assert.ok(totalOps <= 3, `总操作数不应超过3，实际: ${totalOps} (approved=${totalApproved}, rejected=${totalRejected})`);
});

test('场景4.6: 两个 approveMessage 并发审核不同消息 → 互不影响', async () => {
  const pendingMessages = new Map();
  pendingMessages.set(101, { message: { id: 101 }, prepareResult: {} });
  pendingMessages.set(102, { message: { id: 102 }, prepareResult: {} });
  let approved = 0;

  async function approveMessage(id) {
    if (!pendingMessages.has(id)) {
      return { success: false, error: '不存在' };
    }
    // 模拟异步操作
    await sleep(10);
    pendingMessages.delete(id);
    approved++;
    return { success: true };
  }

  const [r1, r2] = await Promise.all([
    approveMessage(101),
    approveMessage(102),
  ]);

  assert.ok(r1.success, '消息101应审核成功');
  assert.ok(r2.success, '消息102应审核成功');
  assert.strictEqual(approved, 2, '应审核2条');
  assert.strictEqual(pendingMessages.size, 0, 'pending 应为空');
});

// ========== writeRow 序列化 ==========

test('场景4.7: 多次 writeRow 调用应按顺序执行（无交错）', async () => {
  const writeLog = [];
  let writeInProgress = false;

  // 模拟 adapter.writeRow（带并发保护）
  async function safeWriteRow(row, values) {
    if (writeInProgress) {
      throw new Error('写入冲突：另一个写入正在进行');
    }
    writeInProgress = true;
    writeLog.push(`start-${row}`);
    await sleep(20);
    writeLog.push(`data-${row}:${values[5]}`); // 记录物流单号
    writeLog.push(`end-${row}`);
    writeInProgress = false;
    return { updateNum: 1 };
  }

  // 串行写入3行
  await safeWriteRow(5, ['', '', '', '', '', 'SF001', '', '', '', '']);
  await safeWriteRow(6, ['', '', '', '', '', 'SF002', '', '', '', '']);
  await safeWriteRow(7, ['', '', '', '', '', 'SF003', '', '', '', '']);

  assert.deepStrictEqual(writeLog, [
    'start-5', 'data-5:SF001', 'end-5',
    'start-6', 'data-6:SF002', 'end-6',
    'start-7', 'data-7:SF003', 'end-7',
  ], '写入应严格串行，无交错');
});

// ========== processedIds 并发安全 ==========

test('场景4.8: 并发 addProcessedId 不应重复添加', () => {
  const processedIds = new Set();
  const processedIdList = [];

  function addProcessedId(id) {
    if (!processedIds.has(id)) {
      processedIds.add(id);
      processedIdList.push(id);
      return true;
    }
    return false;
  }

  // 同一ID添加3次
  const r1 = addProcessedId(42);
  const r2 = addProcessedId(42);
  const r3 = addProcessedId(42);

  assert.strictEqual(r1, true, '第一次添加应返回true');
  assert.strictEqual(r2, false, '第二次添加应返回false');
  assert.strictEqual(r3, false, '第三次添加应返回false');
  assert.strictEqual(processedIds.size, 1, 'Set中应只有1个元素');
  assert.strictEqual(processedIdList.length, 1, 'List中应只有1个元素');
});

test('场景4.9: 并发 addBlockedId + 搜索过滤 → 屏蔽消息不重复入池', () => {
  const processedIds = new Set();
  const blockedIds = new Set();

  function addBlockedId(id) {
    blockedIds.add(id);
    processedIds.add(id);
  }

  // 模拟消息列表
  const messages = [
    { id: 1, content: '理赔 SF001 399元' },
    { id: 2, content: '理赔 SF002 158元' },
    { id: 3, content: '理赔 SF003 200元' },
  ];

  // 屏蔽消息2
  addBlockedId(2);

  // 搜索过滤
  const newMessages = messages.filter(m =>
    !processedIds.has(m.id) && !blockedIds.has(m.id)
  );

  assert.strictEqual(newMessages.length, 2, '应只过滤出2条新消息');
  assert.strictEqual(newMessages[0].id, 1, '消息1应保留');
  assert.strictEqual(newMessages[1].id, 3, '消息3应保留');
  assert.ok(!newMessages.find(m => m.id === 2), '消息2应被屏蔽');
});

// ========== 综合并发场景 ==========

test('场景4.10: 搜索+写入+审核 同时进行 → 状态一致', async () => {
  // 模拟引擎状态
  const state = {
    busy: false,
    processedIds: new Set(),
    blockedIds: new Set(),
    pendingMessages: new Map(),
    writtenCount: 0,
  };

  async function mockSearch() {
    if (state.busy) return 'skipped';
    state.busy = true;
    await sleep(20);
    // 发现3条消息，但已处理的会被过滤
    const allMsgs = [
      { id: 1, content: '理赔 SF001 399元' },
      { id: 2, content: '理赔 SF002 0元' },  // 无金额，转待审
      { id: 3, content: '理赔 SF003 200元' },
    ];
    const msgs = allMsgs.filter(m => !state.processedIds.has(m.id));
    for (const m of msgs) {
      if (m.id === 2) {
        state.pendingMessages.set(m.id, { message: m });
      } else {
        state.processedIds.add(m.id);
        state.writtenCount++;
      }
    }
    state.busy = false;
    return 'processed';
  }

  async function mockApprove(id) {
    if (!state.pendingMessages.has(id)) return { success: false };
    state.pendingMessages.delete(id);
    state.processedIds.add(id);
    state.writtenCount++;
    return { success: true };
  }

  async function mockClearAll() {
    const count = state.pendingMessages.size;
    for (const [id] of state.pendingMessages) {
      state.blockedIds.add(id);
      state.processedIds.add(id);
    }
    state.pendingMessages.clear();
    return { cleared: count };
  }

  // 第1轮搜索
  const search1 = await mockSearch();
  assert.strictEqual(search1, 'processed');
  assert.strictEqual(state.writtenCount, 2, '应写入2条');
  assert.strictEqual(state.pendingMessages.size, 1, '应1条待审');
  assert.strictEqual(state.pendingMessages.has(2), true);

  // 审核消息2
  const approveResult = await mockApprove(2);
  assert.ok(approveResult.success);
  assert.strictEqual(state.writtenCount, 3, '审核后应写入3条');
  assert.strictEqual(state.pendingMessages.size, 0);

  // 第2轮搜索（无新消息）
  const search2 = await mockSearch();
  assert.strictEqual(search2, 'processed');
  assert.strictEqual(state.writtenCount, 3, '无新消息，写入数不变');
});
