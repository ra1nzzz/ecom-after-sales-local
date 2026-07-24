/**
 * http-client.js - 通用 HTTPS 客户端
 *
 * 提供带超时、错误处理和 JSON 解析的 HTTPS 请求封装，
 * 消除各适配器（tencent-docs/feishu-docs/jinshan-docs/wangdian）中重复的 HTTP 请求代码。
 *
 * 使用方式：
 *   const { request, requestJSON, createError } = require('./http-client');
 *   const { statusCode, json } = await requestJSON(options, body, 30000);
 */

const https = require('https');

/**
 * 发送 HTTPS 请求并返回原始响应
 *
 * @param {Object} options - Node.js https.request 选项 { hostname, port, path, method, headers }
 * @param {string|Buffer} [body] - 请求体（GET 请求不传）
 * @param {number} [timeout=60000] - 超时毫秒数
 * @returns {Promise<{statusCode: number, headers: Object, body: string}>}
 */
function request(options, body, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', (e) => {
      reject(new Error('HTTPS请求失败: ' + e.message));
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('HTTPS请求超时'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * 发送 HTTPS 请求并解析 JSON 响应
 *
 * 自动尝试 JSON.parse，解析失败时返回原始文本。
 * 不自动抛出 HTTP 错误（由调用方根据 statusCode 判断），
 * 但会通过 createError 辅助函数方便地创建带 statusCode 的错误。
 *
 * @param {Object} options - Node.js https.request 选项
 * @param {string|Buffer} [body] - 请求体
 * @param {number} [timeout=60000] - 超时毫秒数
 * @returns {Promise<{statusCode: number, headers: Object, json: Object|string, rawBody: string}>}
 */
async function requestJSON(options, body, timeout = 60000) {
  const { statusCode, headers, body: responseBody } = await request(options, body, timeout);
  let json;
  try {
    json = JSON.parse(responseBody);
  } catch (e) {
    json = responseBody; // 非 JSON 响应，返回原始文本
  }
  return { statusCode, headers, json, rawBody: responseBody };
}

/**
 * 创建带 statusCode 属性的错误对象
 * 便于上游通过 err.statusCode 判断 HTTP 状态码
 *
 * @param {string} message - 错误消息
 * @param {number} statusCode - HTTP 状态码
 * @returns {Error} 带 statusCode 属性的 Error
 */
function createError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { request, requestJSON, createError };
