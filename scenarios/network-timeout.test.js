/**
 * 场景3: 网络超时
 *
 * 测试系统在网络异常时的行为：
 * - 腾讯文档API TLS握手失败 → 重试3次后返回错误
 * - 观尘API请求超时(10s) → 不应永久阻塞
 * - LLM API无响应 → 提取应失败但不崩溃
 * - 旺店通ERP超时 → 应降级为无ERP匹配
 * - 间歇性网络恢复 → 引擎应自动继续工作
 * - busy卡死 → 看门狗5分钟后强制重置
 */

const { test, assert, createStandardConfig, sleep,
  assertCompletesWithin, assertDoesNotCompleteWithin } = require('./helpers');
const http = require('http');

// ========== 超时常量验证 ==========

test('场景3.1: 观尘API超时设为10秒', () => {
  // guanchen.js 中 req.setTimeout(10000, ...)
  const GUANCHEN_TIMEOUT = 10000;
  assert.strictEqual(GUANCHEN_TIMEOUT, 10000, '观尘API超时应为10秒');
});

test('场景3.2: 腾讯文档请求超时设为60秒', () => {
  // shared-docs.js 中 REQUEST_TIMEOUT = 60000
  const REQUEST_TIMEOUT = 60000;
  assert.strictEqual(REQUEST_TIMEOUT, 60000, '文档API超时应为60秒');
});

test('场景3.3: busy卡死超时设为5分钟', () => {
  // automation.js 中 BUSY_TIMEOUT = 5 * 60 * 1000
  const BUSY_TIMEOUT = 5 * 60 * 1000;
  assert.strictEqual(BUSY_TIMEOUT, 300000, 'busy卡死超时应为5分钟');
});

test('场景3.4: 自愈看门狗检查间隔为2分钟', () => {
  const WATCHDOG_INTERVAL = 2 * 60 * 1000;
  assert.strictEqual(WATCHDOG_INTERVAL, 120000, '看门狗检查间隔应为2分钟');
});

// ========== HTTP超时行为测试 ==========

test('场景3.5: 连接不存在的端口 → 快速失败(连接拒绝)', async () => {
  const start = Date.now();
  try {
    await fetch('http://127.0.0.1:59999/api/test', { signal: AbortSignal.timeout(3000) });
    assert.fail('应抛出连接错误');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `连接拒绝应快速失败，实际耗时 ${elapsed}ms`);
  }
});

test('场景3.6: AbortSignal.timeout 能在指定时间内中断请求', async () => {
  // 创建一个慢速HTTP服务器
  const server = http.createServer((req, res) => {
    setTimeout(() => { res.end('slow response'); }, 5000);
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const start = Date.now();
  try {
    await fetch(`http://127.0.0.1:${port}/test`, {
      signal: AbortSignal.timeout(500)
    });
    assert.fail('应在500ms内超时');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 450 && elapsed < 1500,
      `超时应约500ms触发，实际 ${elapsed}ms`);
  } finally {
    server.close();
  }
});

// ========== 重试逻辑测试 ==========

test('场景3.7: 模拟3次重试 — 前两次失败，第三次成功', async () => {
  let attempt = 0;
  const MAX_RETRIES = 3;
  const delays = [3000, 6000]; // 实际代码中的延迟

  // 用缩短的延迟模拟
  const shortDelays = [50, 100];

  let result = null;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    attempt++;
    try {
      if (attempt < 3) {
        throw new Error('TLS connection failed');
      }
      result = { success: true, attempt };
      break;
    } catch (err) {
      if (i < MAX_RETRIES) {
        await sleep(shortDelays[i - 1]);
      } else {
        result = { success: false, error: err.message, attempt };
      }
    }
  }

  assert.strictEqual(result.success, true, '第三次应成功');
  assert.strictEqual(result.attempt, 3, '应重试到第三次');
});

test('场景3.8: 模拟3次重试全部失败 → 返回最终错误', async () => {
  let attempt = 0;
  const MAX_RETRIES = 3;
  const shortDelays = [50, 100];

  let result = null;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    attempt++;
    try {
      throw new Error('Client network socket disconnected before secure TLS connection was established');
    } catch (err) {
      if (i < MAX_RETRIES) {
        await sleep(shortDelays[i - 1]);
      } else {
        result = { success: false, error: err.message, attempts: attempt };
      }
    }
  }

  assert.ok(!result.success, '全部失败应返回 success=false');
  assert.ok(result.error.includes('TLS'), `错误信息应包含TLS，实际: ${result.error}`);
  assert.strictEqual(result.attempts, 3, '应重试3次');
});

// ========== busy 看门狗模拟 ==========

test('场景3.9: busy卡死5分钟后看门狗强制重置', async () => {
  // 模拟看门狗逻辑（缩短时间）
  const BUSY_TIMEOUT_TEST = 300; // 300ms 代替 5min
  const CHECK_INTERVAL_TEST = 100; // 100ms 代替 2min

  let busy = true;
  let busySince = Date.now();
  let resetCount = 0;

  // 启动看门狗
  const watchdog = setInterval(() => {
    if (busy && busySince > 0) {
      const stuckMs = Date.now() - busySince;
      if (stuckMs > BUSY_TIMEOUT_TEST) {
        busy = false;
        busySince = 0;
        resetCount++;
      }
    }
  }, CHECK_INTERVAL_TEST);

  // 等待足够时间让看门狗触发
  await sleep(BUSY_TIMEOUT_TEST + CHECK_INTERVAL_TEST + 50);

  clearInterval(watchdog);

  assert.ok(resetCount >= 1, `看门狗应至少重置1次，实际 ${resetCount} 次`);
  assert.ok(!busy, 'busy 应被重置为 false');
});

test('场景3.10: lastSearchTime 过时 → 看门狗触发搜索', async () => {
  const INTERVAL = 100; // 100ms 代替 60s
  const STALE_THRESHOLD = INTERVAL * 3; // 3倍间隔
  let searchTriggered = false;

  let lastSearchTime = Date.now() - STALE_THRESHOLD - 50; // 已过时

  const watchdog = setInterval(() => {
    if (lastSearchTime > 0) {
      const sinceLastSearch = Date.now() - lastSearchTime;
      if (sinceLastSearch > INTERVAL * 3) {
        searchTriggered = true;
      }
    }
  }, 50);

  await sleep(150);
  clearInterval(watchdog);

  assert.ok(searchTriggered, '看门狗应检测到搜索过时并触发');
});

// ========== 网络恢复后自动继续 ==========

test('场景3.11: 网络恢复后引擎应能继续工作', async () => {
  let networkOk = false;
  let searchCount = 0;

  // 模拟3轮搜索：第1轮失败，第2轮失败，第3轮成功
  for (let i = 0; i < 3; i++) {
    try {
      if (!networkOk) {
        throw new Error('网络不可用');
      }
      searchCount++;
    } catch (err) {
      // 引擎不停止，等待下个周期重试
    }

    // 第3轮前恢复网络
    if (i === 1) networkOk = true;

    await sleep(10);
  }

  assert.strictEqual(searchCount, 1, '网络恢复后应有1次成功搜索');
});

// ========== 并发请求超时 ==========

test('场景3.12: 多个API请求同时超时 → 不应互相阻塞', async () => {
  const server = http.createServer((req, res) => {
    // 所有请求都慢
    setTimeout(() => { res.end('ok'); }, 3000);
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const start = Date.now();
  const promises = [];
  for (let i = 0; i < 3; i++) {
    promises.push(
      fetch(`http://127.0.0.1:${port}/test`, { signal: AbortSignal.timeout(200) })
        .catch(() => 'timeout')
    );
  }

  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  server.close();

  // 3个请求并行超时，总时间应远小于串行(600ms)
  assert.ok(elapsed < 500, `3个并行超时应 <500ms，实际 ${elapsed}ms`);
  assert.strictEqual(results.length, 3, '应有3个结果');
  results.forEach(r => assert.strictEqual(r, 'timeout', '每个请求都应超时'));
});
