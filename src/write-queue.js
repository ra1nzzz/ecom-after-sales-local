/**
 * write-queue.js - 写入队列与限流状态管理
 *
 * 职责：
 * - rateLimitedUntil: 限流截止时间戳（北京时间当天 23:59:59.999）
 * - pendingQueue: 待写入的记录数组 [{ message, prepareResult }]
 * - 提供入队/出队/批量出队/限流检测/持久化序列化等能力
 *
 * 持久化：通过 automation-state.json 的 writeQueue 字段保存
 */

const MAX_WRITE_BATCH = 5;

// 北京时间相对 UTC 的偏移（毫秒）
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

let state = {
  rateLimitedUntil: 0,
  pendingQueue: []
};

let dirty = false;

/**
 * 计算当前北京时间当天的 23:59:59.999 对应的 UTC 时间戳
 * 思路：将 UTC 时间戳平移到北京时间，用 UTC 字段读取"北京墙上时钟"，
 * 构造当天 23:59:59.999 后再减回偏移量。
 */
function getEndOfTodayBeijing() {
  const now = new Date();
  const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const year = beijingNow.getUTCFullYear();
  const month = beijingNow.getUTCMonth();
  const day = beijingNow.getUTCDate();
  const beijingEnd = Date.UTC(year, month, day, 23, 59, 59, 999);
  return beijingEnd - BEIJING_OFFSET_MS;
}

/**
 * 是否处于限流期
 */
function isRateLimited() {
  return Date.now() < state.rateLimitedUntil;
}

/**
 * 获取限流截止时间戳
 */
function getRateLimitedUntil() {
  return state.rateLimitedUntil;
}

/**
 * 设置限流到北京时间当天 23:59:59
 */
function setRateLimited() {
  state.rateLimitedUntil = getEndOfTodayBeijing();
  dirty = true;
  const expireLocal = new Date(state.rateLimitedUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[write-queue] 限流已触发，写入暂停至北京时间 ${expireLocal}`);
}

/**
 * 入队一条记录（追加到队尾）
 * @param {{ message: object, prepareResult: object }} record
 */
function enqueue(record) {
  state.pendingQueue.push(record);
  dirty = true;
}

/**
 * 入队到队首（用于写失败后回填，保持重试顺序）
 */
function enqueueFront(record) {
  state.pendingQueue.unshift(record);
  dirty = true;
}

/**
 * 取出全部待写记录并清空队列
 */
function drainQueue() {
  const records = state.pendingQueue;
  state.pendingQueue = [];
  dirty = true;
  return records;
}

/**
 * 从队首取出最多 maxSize 条记录（移除）
 */
function dequeueBatch(maxSize) {
  const batch = state.pendingQueue.splice(0, maxSize);
  if (batch.length > 0) dirty = true;
  return batch;
}

/**
 * 队列大小
 */
function getQueueSize() {
  return state.pendingQueue.length;
}

/**
 * 判断某消息ID是否已在队列中（避免重复入队）
 */
function hasMessage(messageId) {
  return state.pendingQueue.some(r => r.message && r.message.id === messageId);
}

/**
 * 序列化为可持久化对象
 */
function serialize() {
  return {
    rateLimitedUntil: state.rateLimitedUntil,
    pendingQueue: state.pendingQueue
  };
}

/**
 * 从持久化对象恢复状态
 */
function load(saved) {
  if (saved && typeof saved === 'object') {
    state.rateLimitedUntil = saved.rateLimitedUntil || 0;
    state.pendingQueue = Array.isArray(saved.pendingQueue) ? saved.pendingQueue : [];
    dirty = false;
    console.log(`[write-queue] 状态已恢复: 限流截止=${state.rateLimitedUntil ? new Date(state.rateLimitedUntil).toISOString() : '无'}, 队列=${state.pendingQueue.length}条`);
  }
}

/**
 * 是否有未持久化的变更
 */
function isDirty() {
  return dirty;
}

/**
 * 标记为已持久化（clean）
 */
function markClean() {
  dirty = false;
}

module.exports = {
  MAX_WRITE_BATCH,
  isRateLimited,
  getRateLimitedUntil,
  setRateLimited,
  enqueue,
  enqueueFront,
  drainQueue,
  dequeueBatch,
  getQueueSize,
  hasMessage,
  serialize,
  load,
  isDirty,
  markClean
};
