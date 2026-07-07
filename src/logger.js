/**
 * logger.js - 操作日志系统
 * 记录所有人工和自动操作，持久化存储，自动清理3天前的日志
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'automation-logs.json');
const LOG_TTL = 3 * 24 * 60 * 60 * 1000; // 3天
const MAX_LOGS = 5000; // 最大日志条数

let logs = [];
let dirty = false;
let flushTimer = null;

/**
 * 初始化：加载持久化日志，清理过期项
 */
function init() {
  loadLogs();
  cleanExpired();
  // 每5分钟落盘一次（如果有变化）
  flushTimer = setInterval(flush, 5 * 60 * 1000);
  console.log(`[logger] 初始化完成，当前 ${logs.length} 条日志`);
}

/**
 * 记录一条日志
 * @param {string} type - 日志类型: auto_search, auto_extract, auto_write, auto_approve, auto_reject, auto_clear, auto_reextract, manual_write, manual_search, config_save, system
 * @param {string} action - 具体操作描述
 * @param {object} details - 附加详情
 */
function log(type, action, details = {}) {
  const entry = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    time: new Date().toISOString(),
    type,
    action,
    details
  };
  logs.push(entry);
  dirty = true;

  // 控制台同步输出
  const prefix = `[${entry.time}] [${type}]`;
  const detailStr = Object.keys(details).length > 0 ? ' ' + JSON.stringify(details) : '';
  console.log(`${prefix} ${action}${detailStr}`);

  // 超过上限时清理旧日志
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(-MAX_LOGS);
  }

  return entry;
}

/**
 * 获取日志列表
 * @param {object} options - { limit, type, since }
 */
function getLogs(options = {}) {
  let result = logs;
  if (options.type) {
    result = result.filter(l => l.type === options.type);
  }
  if (options.since) {
    const sinceTime = new Date(options.since).getTime();
    result = result.filter(l => new Date(l.time).getTime() >= sinceTime);
  }
  const limit = options.limit || 200;
  return result.slice(-limit).reverse(); // 最新在前
}

/**
 * 清空所有日志
 */
function clearLogs() {
  logs = [];
  dirty = true;
  flush();
  console.log('[logger] 所有日志已清空');
}

/**
 * 清理过期日志（3天前）
 */
function cleanExpired() {
  const cutoff = Date.now() - LOG_TTL;
  const before = logs.length;
  logs = logs.filter(l => new Date(l.time).getTime() > cutoff);
  const removed = before - logs.length;
  if (removed > 0) {
    dirty = true;
    console.log(`[logger] 清理 ${removed} 条过期日志`);
  }
}

/**
 * 加载持久化日志
 */
function loadLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    logs = JSON.parse(raw);
    if (!Array.isArray(logs)) logs = [];
  } catch (err) {
    console.error('[logger] 加载日志失败:', err.message);
    logs = [];
  }
}

/**
 * 落盘持久化
 */
function flush() {
  if (!dirty) return;
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
    dirty = false;
  } catch (err) {
    console.error('[logger] 日志落盘失败:', err.message);
  }
}

/**
 * 关闭：落盘并停止定时器
 */
function shutdown() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flush();
}

module.exports = { init, log, getLogs, clearLogs, flush, shutdown };
