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
 * 观尘API要求指定chat_wxid才能返回消息，不传则返回空。
 * 此函数自动获取所有授权群聊，逐个搜索后合并结果并按时间倒序排序。
 * @returns {Promise<{total, limit, offset, messages: Array}>}
 */
async function searchMessages(guanchenConfig, keyword, limit = 50) {
  // 先获取所有授权群聊
  const chatsResp = await getChats(guanchenConfig);
  const chats = chatsResp.chats || [];
  if (chats.length === 0) {
    return { total: 0, limit, offset: 0, messages: [] };
  }

  // 对每个群聊搜索消息
  const searchPromises = chats.map(chat => {
    const wxid = chat.wxid || chat.chat_wxid;
    if (!wxid) return Promise.resolve({ messages: [] });
    return callGet(guanchenConfig.baseUrl, '/openapi/messages', guanchenConfig.apiKey, {
      chat_wxid: wxid,
      keyword,
      limit
    }).catch(err => {
      console.error(`[guanchen] 搜索群聊 ${wxid} 失败:`, err.message);
      return { messages: [] };
    });
  });

  const results = await Promise.all(searchPromises);

  // 合并所有群聊的消息并按 msg_time 倒序排序
  const allMessages = [];
  for (const r of results) {
    if (r.messages && Array.isArray(r.messages)) {
      allMessages.push(...r.messages);
    }
  }
  allMessages.sort((a, b) => (b.msg_time || 0) - (a.msg_time || 0));

  // 截取前 limit 条
  const topMessages = allMessages.slice(0, limit);

  return { total: allMessages.length, limit, offset: 0, messages: topMessages };
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
