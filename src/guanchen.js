/**
 * guanchen.js - 观尘API客户端
 * 通过观尘本地服务搜索微信消息，用于自动化登记
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * 底层 GET 请求封装
 */
function callGet(baseUrl, path, apiKey, params = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) fullUrl.searchParams.set(k, v);
    }

    const transport = fullUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json'
      }
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      let dataSize = 0;
      res.on('data', chunk => {
        dataSize += chunk.length;
        if (dataSize > MAX_RESPONSE_SIZE) {
          reject(new Error('观尘API响应体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('观尘API鉴权失败(' + res.statusCode + '): ' + data.substring(0, 200)));
          } else {
            reject(new Error('观尘API请求失败(' + res.statusCode + '): ' + data.substring(0, 200)));
          }
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('观尘API返回非JSON: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', e => reject(new Error('观尘API请求失败: ' + e.message)));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('观尘API请求超时')); });
    req.end();
  });
}

/**
 * 获取会话列表
 */
async function getChats(guanchenConfig) {
  return callGet(guanchenConfig.baseUrl, '/openapi/chats', guanchenConfig.apiKey);
}

/**
 * 按关键词搜索消息
 * @returns {Promise<{total, limit, offset, messages: Array}>}
 */
async function searchMessages(guanchenConfig, keyword, limit = 50) {
  return callGet(guanchenConfig.baseUrl, '/openapi/messages', guanchenConfig.apiKey, { keyword, limit });
}

/**
 * 测试连接
 */
async function testConnection(guanchenConfig) {
  try {
    const resp = await getChats(guanchenConfig);
    const chatCount = (resp.chats || []).length;
    return { ok: true, success: true, message: `连接成功，授权${chatCount}个群聊`, data: resp };
  } catch (err) {
    return { ok: false, success: false, message: err.message };
  }
}

module.exports = { callGet, getChats, searchMessages, testConnection };
