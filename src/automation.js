/**
 * automation.js - 观尘API自动化引擎
 * 定时搜索微信消息 → 提取结构化数据 → 自动写入或人工审核后写入文档
 * 带消息ID去重和状态持久化
 */

const fs = require('fs');
const path = require('path');
const guanchen = require('./guanchen');
const pipeline = require('./write-pipeline');
const logger = require('./logger');

const STATE_FILE = path.join(__dirname, '..', 'automation-state.json');
const MAX_PROCESSED_IDS = 1000;
const SEARCH_LIMIT = 200;       // 搜索最近200条（覆盖更多未处理消息）
const MAX_BATCH_SIZE = 20;      // 每轮最多处理20条（避免单轮耗时过长）
const DEFAULT_SEARCH_INTERVAL = 60000;
const PENDING_TTL = 7 * 24 * 60 * 60 * 1000; // 7天
const MAX_PENDING = 200;

let engine = {
  running: false,
  busy: false,
  dirty: false,
  timer: null,
  config: null,
  lastSearchTime: 0,
  lastError: null,
  stats: {
    totalFound: 0,
    totalProcessed: 0,
    totalAutoWritten: 0,
    totalPending: 0,
    totalRejected: 0,
    totalFailed: 0,
    totalExtractFailed: 0,
    totalWriteFailed: 0
  },
  processedIds: new Set(),
  processedIdList: [],
  pendingMessages: new Map()
};

/**
 * 初始化引擎：加载持久化状态，若配置启用则自动启动
 */
function init(config) {
  engine.config = config;
  loadState();
  if (config.guanchen && config.guanchen.enabled && config.guanchen.apiKey) {
    console.log('[automation] 配置已启用，自动启动引擎');
    start(config);
  } else {
    console.log('[automation] 引擎未启用，等待手动启动');
  }
}

/**
 * 启动引擎
 */
function start(config) {
  if (engine.running) {
    console.log('[automation] 引擎已在运行中');
    return false;
  }
  engine.config = config;
  const interval = (config.guanchen && config.guanchen.searchInterval) || DEFAULT_SEARCH_INTERVAL;
  engine.running = true;
  engine.lastError = null;
  console.log(`[automation] 引擎已启动，搜索间隔 ${interval / 1000}秒`);

  // 立即执行一次
  searchAndProcess().catch(err => {
    console.error('[automation] 首次执行失败:', err.message);
  });

  // 设置定时器
  engine.timer = setInterval(() => {
    searchAndProcess().catch(err => {
      console.error('[automation] 定时执行失败:', err.message);
    });
  }, interval);

  return true;
}

/**
 * 停止引擎
 */
function stop() {
  if (engine.timer) {
    clearInterval(engine.timer);
    engine.timer = null;
  }
  engine.running = false;
  console.log('[automation] 引擎已停止');
}

/**
 * 获取引擎状态
 */
function getStatus() {
  return {
    running: engine.running,
    lastSearchTime: engine.lastSearchTime,
    lastError: engine.lastError,
    stats: { ...engine.stats },
    pendingCount: engine.pendingMessages.size,
    processedCount: engine.processedIds.size
  };
}

/**
 * 获取待审消息列表
 */
function getPendingMessages() {
  const result = [];
  for (const [id, item] of engine.pendingMessages) {
    result.push({
      id,
      message: item.message,
      prepareResult: item.prepareResult,
      addedAt: item.addedAt
    });
  }
  return result;
}

/**
 * 核心流程：搜索消息 → 过滤已处理 → 提取 → 写入或加入待审
 */
async function searchAndProcess() {
  if (engine.busy) {
    console.log('[automation] 上一轮仍在执行，跳过本轮');
    return;
  }

  if (!engine.config || !engine.config.guanchen) {
    engine.lastError = '观尘配置缺失';
    return;
  }

  const gcfg = engine.config.guanchen;
  if (!gcfg.apiKey) {
    engine.lastError = '观尘API Key未配置';
    return;
  }

  engine.busy = true;
  try {
    const keyword = gcfg.keyword || '理赔';
    const resp = await guanchen.searchMessages(gcfg, keyword, SEARCH_LIMIT);
    const messages = resp.messages || [];

    // 过滤已处理的消息
    let newMessages = messages.filter(m => !engine.processedIds.has(m.id));

    // 过滤：要求消息内容同时带有数字
    if (gcfg.requireDigits) {
      const before = newMessages.length;
      newMessages = newMessages.filter(m => /\d/.test(m.content || ''));
      const filtered = before - newMessages.length;
      if (filtered > 0) {
        logger.log('auto_search', `过滤掉 ${filtered} 条不含数字的消息`, { keyword, requireDigits: true });
      }
    }

    engine.lastSearchTime = Date.now();
    engine.lastError = null;

    if (newMessages.length === 0) {
      console.log(`[automation] 无新消息（已处理 ${engine.processedIds.size} 条）`);
      // 心跳日志：即使无新消息也记录搜索行为，证明引擎在运转
      logger.log('auto_search', `搜索完成，无新消息`, {
        keyword,
        total: resp.total,
        processed: engine.processedIds.size,
        requireDigits: !!gcfg.requireDigits
      });
      // 强制持久化 lastSearchTime（绕过dirty检查）
      engine.dirty = true;
      await persistState();
      return;
    }

    engine.stats.totalFound += newMessages.length;
    engine.dirty = true;

    // 限制每轮处理数量，避免单轮耗时过长
    const remaining = newMessages.length;
    if (remaining > MAX_BATCH_SIZE) {
      newMessages = newMessages.slice(0, MAX_BATCH_SIZE);
    }

    console.log(`[automation] 发现 ${remaining} 条新消息，本轮处理 ${newMessages.length} 条`);
    logger.log('auto_search', `发现 ${remaining} 条新消息`, {
      keyword,
      total: resp.total,
      processing: newMessages.length,
      remaining: remaining - newMessages.length
    });

    // 解析目标文档和表格
    const targetResult = pipeline.resolveTarget(engine.config, gcfg.targetDocId, gcfg.targetId);
    if (!targetResult.success) {
      engine.lastError = targetResult.error;
      console.error('[automation] 目标解析失败:', targetResult.error);
      await persistState();
      return;
    }

    const { doc, target } = targetResult;

    // 读取表头（每轮只读一次，复用给所有消息）
    const headersInfo = await pipeline.readSheetHeaders(engine.config, doc, target);
    if (!headersInfo.success) {
      engine.lastError = '读取表头失败: ' + headersInfo.error;
      console.error('[automation] 读取表头失败:', headersInfo.error);
      await persistState();
      return;
    }

    // 逐条处理新消息
    for (const message of newMessages) {
      await processMessage(message, doc, target, headersInfo);
    }

    // 清理超期待审消息
    cleanExpiredPending();
    await persistState();
    console.log(`[automation] 本轮处理完成，已写入 ${engine.stats.totalAutoWritten}，待审 ${engine.pendingMessages.size}`);
  } catch (err) {
    engine.lastError = err.message;
    console.error('[automation] 搜索处理失败:', err.message);
    // 不停止引擎，等待下个周期重试
  } finally {
    engine.busy = false;
  }
}

/**
 * 处理单条消息：提取 → 自动写入或加入待审
 */
async function processMessage(message, doc, target, headersInfo) {
  const messageId = message.id;
  const content = message.content || '';

  console.log(`[automation] 处理消息 #${messageId}: ${content.substring(0, 60)}...`);

  try {
    const prepareResult = await pipeline.extractAndPrepare(
      engine.config, doc, target, content, headersInfo, headersInfo.parsedRows
    );

    if (!prepareResult.success) {
      // 提取失败 → 标记为已处理，避免重复尝试
      addProcessedId(messageId);
      engine.stats.totalExtractFailed++;
      engine.stats.totalFailed++;
      engine.dirty = true;
      logger.log('auto_extract', `消息 #${messageId} 提取失败`, { error: prepareResult.error, content: content.substring(0, 100) });
      console.log(`[automation] 消息 #${messageId} 提取失败: ${prepareResult.error}`);
      return;
    }

    // 记录提取结果（含ERP匹配状态）
    logger.log('auto_extract', `消息 #${messageId} 提取完成`, {
      method: prepareResult.debug?.method,
      wdtMatched: !!prepareResult.debug?.wdtMatch,
      nonEmptyCount: prepareResult.debug?.nonEmptyCount,
      duplicate: !!prepareResult.duplicate
    });

    if (engine.config.guanchen.autoConfirm) {
      // 全自动模式：直接写入
      const writeResult = await pipeline.executeWrite(engine.config, doc, prepareResult, headersInfo);
      if (writeResult.success) {
        addProcessedId(messageId);
        engine.stats.totalAutoWritten++;
        engine.dirty = true;
        // 更新内存快照：将新行追加到 parsedRows，避免同批次查重失效
        if (headersInfo.parsedRows && writeResult.newRowValues) {
          headersInfo.parsedRows.push(writeResult.newRowValues);
        }
        logger.log('auto_write', `消息 #${messageId} 自动写入成功`, { row: writeResult.row });
        console.log(`[automation] 消息 #${messageId} 已自动写入`);
      } else {
        // 写入失败 → 不加processedIds，下轮重试
        engine.stats.totalWriteFailed++;
        engine.stats.totalFailed++;
        engine.dirty = true;
        logger.log('auto_write', `消息 #${messageId} 自动写入失败`, { error: writeResult.error });
        console.error(`[automation] 消息 #${messageId} 写入失败:`, writeResult.error);
      }
    } else {
      // 半自动模式：加入待审队列
      engine.pendingMessages.set(messageId, {
        message,
        prepareResult,
        addedAt: Date.now()
      });
      engine.stats.totalPending++;
      engine.dirty = true;
      console.log(`[automation] 消息 #${messageId} 已加入待审队列`);
    }
  } catch (err) {
    // 提取过程异常 → 标记为已处理
    addProcessedId(messageId);
    engine.stats.totalExtractFailed++;
    engine.stats.totalFailed++;
    engine.dirty = true;
    console.error(`[automation] 消息 #${messageId} 处理异常:`, err.message);
  }
}

/**
 * 人工审核通过：写入文档
 */
async function approveMessage(messageId, latestConfig) {
  // 兼容数字和字符串类型的 messageId（前端传字符串，Map key 是数字）
  const id = Number(messageId);
  const item = engine.pendingMessages.get(id) || engine.pendingMessages.get(messageId);
  if (!item) {
    return { success: false, error: '待审消息不存在' };
  }

  // 使用最新配置（配置可能已变更）
  const cfg = latestConfig || engine.config;
  const gcfg = cfg.guanchen;
  const targetResult = pipeline.resolveTarget(cfg, gcfg.targetDocId, gcfg.targetId);
  if (!targetResult.success) {
    return { success: false, error: targetResult.error };
  }

  const { doc } = targetResult;

  // 重新读取表头（审核时需要最新的表头和适配器状态）
  const headersInfo = await pipeline.readSheetHeaders(cfg, doc, targetResult.target);
  if (!headersInfo.success) {
    return { success: false, error: '读取表头失败: ' + headersInfo.error };
  }

  const writeResult = await pipeline.executeWrite(cfg, doc, item.prepareResult, headersInfo);
  if (!writeResult.success) {
    return { success: false, error: '写入失败: ' + writeResult.error };
  }

  addProcessedId(id);
  engine.pendingMessages.delete(id);
  engine.stats.totalPending = Math.max(0, engine.stats.totalPending - 1);
  engine.dirty = true;
  await persistState();
  logger.log('auto_approve', `消息 #${id} 审核通过并写入`, { row: writeResult.row });
  console.log(`[automation] 消息 #${id} 审核通过并写入，行: ${writeResult.row}`);
  return { success: true, row: writeResult.row };
}

/**
 * 人工审核拒绝
 */
async function rejectMessage(messageId) {
  // 兼容数字和字符串类型的 messageId
  const id = Number(messageId);
  const item = engine.pendingMessages.get(id) || engine.pendingMessages.get(messageId);
  if (!item) {
    return { success: false, error: '待审消息不存在' };
  }

  engine.pendingMessages.delete(id);
  addProcessedId(id);
  engine.stats.totalPending = Math.max(0, engine.stats.totalPending - 1);
  engine.stats.totalRejected++;
  engine.dirty = true;
  await persistState();
  logger.log('auto_reject', `消息 #${id} 已拒绝`);
  console.log(`[automation] 消息 #${id} 已拒绝`);
  return { success: true };
}

/**
 * 清空所有待审消息（标记为已拒绝）
 */
async function clearAllPending() {
  const count = engine.pendingMessages.size;
  if (count === 0) return { success: true, cleared: 0 };
  for (const [id] of engine.pendingMessages) {
    addProcessedId(id);
    engine.stats.totalRejected++;
  }
  engine.pendingMessages.clear();
  engine.stats.totalPending = 0;
  engine.dirty = true;
  await persistState();
  logger.log('auto_clear', `清空所有待审消息`, { count });
  console.log(`[automation] 清空 ${count} 条待审消息`);
  return { success: true, cleared: count };
}

/**
 * 重新识别待审消息（对单条消息重新提取）
 */
async function reExtractMessage(messageId, latestConfig) {
  const id = Number(messageId);
  const item = engine.pendingMessages.get(id) || engine.pendingMessages.get(messageId);
  if (!item) {
    return { success: false, error: '待审消息不存在' };
  }

  const cfg = latestConfig || engine.config;
  const gcfg = cfg.guanchen;
  const targetResult = pipeline.resolveTarget(cfg, gcfg.targetDocId, gcfg.targetId);
  if (!targetResult.success) {
    return { success: false, error: targetResult.error };
  }

  const { doc, target } = targetResult;
  const headersInfo = await pipeline.readSheetHeaders(cfg, doc, target);
  if (!headersInfo.success) {
    return { success: false, error: '读取表头失败: ' + headersInfo.error };
  }

  const content = item.message.content || '';
  const prepareResult = await pipeline.extractAndPrepare(
    cfg, doc, target, content, headersInfo, headersInfo.parsedRows
  );

  if (!prepareResult.success) {
    logger.log('auto_reextract', `消息 #${id} 重新识别失败`, { error: prepareResult.error });
    return { success: false, error: '重新识别失败: ' + prepareResult.error };
  }

  // 更新待审消息的 prepareResult
  item.prepareResult = prepareResult;
  engine.dirty = true;
  await persistState();
  logger.log('auto_reextract', `消息 #${id} 重新识别完成`, {
    method: prepareResult.debug?.method,
    wdtMatched: !!prepareResult.debug?.wdtMatch,
    nonEmptyCount: prepareResult.debug?.nonEmptyCount
  });
  console.log(`[automation] 消息 #${id} 重新识别完成`);
  return { success: true, prepareResult };
}

/**
 * 持久化状态到文件
 */
async function persistState() {
  if (!engine.dirty) return;
  try {
    trimProcessedIds();
    const state = {
      processedIds: Array.from(engine.processedIdList),
      pendingMessages: Array.from(engine.pendingMessages.entries()).map(([id, item]) => ({
        id,
        message: item.message,
        prepareResult: item.prepareResult,
        addedAt: item.addedAt
      })),
      stats: engine.stats,
      lastSearchTime: engine.lastSearchTime
    };
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    engine.dirty = false;
  } catch (err) {
    console.error('[automation] 状态持久化失败:', err.message);
  }
}

/**
 * 从文件加载状态
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);

    if (Array.isArray(state.processedIds)) {
      engine.processedIds = new Set(state.processedIds);
      engine.processedIdList = Array.from(engine.processedIds);
    }
    if (Array.isArray(state.pendingMessages)) {
      engine.pendingMessages = new Map();
      for (const item of state.pendingMessages) {
        engine.pendingMessages.set(item.id, {
          message: item.message,
          prepareResult: item.prepareResult,
          addedAt: item.addedAt || Date.now()
        });
      }
    }
    if (state.stats) {
      engine.stats = { ...engine.stats, ...state.stats };
      // 向后兼容：旧state只有totalFailed，不拆分
      if (state.stats.totalExtractFailed === undefined) {
        engine.stats.totalExtractFailed = 0;
        engine.stats.totalWriteFailed = 0;
      }
    }
    if (state.lastSearchTime) {
      engine.lastSearchTime = state.lastSearchTime;
    }

    console.log(`[automation] 状态已恢复: ${engine.processedIds.size} 条已处理, ${engine.pendingMessages.size} 条待审`);
  } catch (err) {
    console.error('[automation] 状态加载失败:', err.message);
  }
}

/**
 * 裁剪 processedIds，保留最近 MAX_PROCESSED_IDS 条
 */
function trimProcessedIds() {
  if (engine.processedIdList.length <= MAX_PROCESSED_IDS) return;
  const removeCount = engine.processedIdList.length - MAX_PROCESSED_IDS;
  const removed = engine.processedIdList.splice(0, removeCount);
  for (const id of removed) {
    engine.processedIds.delete(id);
  }
  console.log(`[automation] processedIds 已裁剪至 ${engine.processedIdList.length} 条`);
}

/**
 * 添加已处理ID（同步维护 Set 与插入顺序数组）
 */
function addProcessedId(id) {
  if (!engine.processedIds.has(id)) {
    engine.processedIds.add(id);
    engine.processedIdList.push(id);
    engine.dirty = true;
  }
}

/**
 * 清理超期待审消息，并控制待审队列上限
 */
function cleanExpiredPending() {
  const now = Date.now();
  const expiredIds = [];
  for (const [id, item] of engine.pendingMessages) {
    if (now - item.addedAt > PENDING_TTL) {
      expiredIds.push(id);
    }
  }
  for (const id of expiredIds) {
    engine.pendingMessages.delete(id);
    addProcessedId(id);
    engine.stats.totalRejected++;
    engine.stats.totalPending = Math.max(0, engine.stats.totalPending - 1);
    engine.dirty = true;
  }
  if (expiredIds.length > 0) {
    console.log(`[automation] 清理 ${expiredIds.length} 条超期待审消息`);
  }

  // 超过上限时拒绝最早的（按 addedAt 排序）
  while (engine.pendingMessages.size > MAX_PENDING) {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, item] of engine.pendingMessages) {
      if (item.addedAt < oldestTime) {
        oldestTime = item.addedAt;
        oldestId = id;
      }
    }
    engine.pendingMessages.delete(oldestId);
    addProcessedId(oldestId);
    engine.stats.totalRejected++;
    engine.stats.totalPending = Math.max(0, engine.stats.totalPending - 1);
    engine.dirty = true;
    console.log(`[automation] 待审队列超限，拒绝最早消息 #${oldestId}`);
  }
}

/**
 * 优雅关闭：停止引擎并持久化状态
 */
async function shutdown() {
  console.log('[automation] 正在优雅关闭...');
  stop();
  engine.dirty = true;
  await persistState();
  console.log('[automation] 状态已持久化');
}

module.exports = {
  init,
  start,
  stop,
  getStatus,
  getPendingMessages,
  searchAndProcess,
  approveMessage,
  rejectMessage,
  clearAllPending,
  reExtractMessage,
  shutdown
};
