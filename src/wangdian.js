/**
 * 旺店通旗舰版 OpenAPI 客户端
 * 签名算法: MD5(secret + 按key正序排列的key-value拼接 + secret)
 */

const crypto = require('crypto');
const https = require('https');
const { PLATFORMS, TRADE_STATUS_MAP, WDT_FIELD_MAP, LOGISTICS_NO_REGEX } = require('./constants');

const BASE_TIME = 1325347200; // 2012-01-01 00:00:00
const API_HOST = 'wdt.wangdian.cn';
const API_PATH = '/openapi';

/**
 * 计算签名
 */
function calcSign(secret, params) {
  const sortedKeys = Object.keys(params).sort();
  let signStr = secret;
  for (const k of sortedKeys) {
    signStr += k + params[k];
  }
  signStr += secret;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
}

/**
 * 调用旺店通API
 */
function callApi(credentials, method, bodyParams) {
  return new Promise((resolve, reject) => {
    const { sid, key, secret, salt } = credentials;
    const timestamp = Math.floor(Date.now() / 1000) - BASE_TIME;
    const bodyContent = JSON.stringify([bodyParams]);

    const signParams = {
      body: bodyContent,
      calc_total: '1',
      key: key,
      method: method,
      page_no: '0',
      page_size: '40',
      salt: salt,
      sid: sid,
      timestamp: String(timestamp),
      v: '1.0',
    };

    const sign = calcSign(secret, signParams);

    const queryParams = {
      sid, key, salt, method,
      timestamp: String(timestamp), v: '1.0', sign,
      page_size: '40', page_no: '0', calc_total: '1'
    };

    const queryString = Object.entries(queryParams)
      .map(([k, val]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(val)))
      .join('&');

    const options = {
      hostname: API_HOST,
      port: 443,
      path: API_PATH + '?' + queryString,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyContent)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('旺店通API返回非JSON: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error('旺店通API请求失败: ' + e.message));
    });

    req.write(bodyContent);
    req.end();
  });
}

/**
 * 从店铺名称解析平台和店铺名
 * 例如: "京东 福临门食安专卖店15371587" → { platform: "京东", shopName: "福临门食安专卖店" }
 */
function parseShopInfo(fullShopName) {
  if (!fullShopName) return { platform: '', shopName: '' };
  
  let platform = '';
  let shopName = fullShopName;
  
  // 尝试匹配平台
  for (const p of PLATFORMS) {
    if (fullShopName.startsWith(p) || fullShopName.includes(' ' + p) || fullShopName.includes(p + ' ')) {
      platform = p;
      break;
    }
  }
  
  // 如果有空格分隔，取空格后的部分作为店铺名
  const parts = fullShopName.split(/\s+/);
  if (parts.length >= 2) {
    if (!platform) {
      platform = parts[0].substring(0, 2);
    }
    shopName = parts.slice(1).join(' ');
  }
  
  // 去掉店铺名末尾的数字ID
  shopName = shopName.replace(/\d+$/, '').trim();
  
  return { platform, shopName };
}

/**
 * 查询订单 - 支持物流单号或原始单号
 */
async function queryOrder(credentials, query) {
  const q = String(query || '').trim();
  if (!q) {
    return { success: false, error: '查询内容不能为空' };
  }

  // 先尝试用 logistics_no 查询
  let result = await callApi(credentials, 'sales.TradeQuery.queryWithDetail', {
    logistics_no: q
  });

  // 如果没找到，再用 src_tid 查询
  if (!result.data || !result.data.order || result.data.order.length === 0) {
    result = await callApi(credentials, 'sales.TradeQuery.queryWithDetail', {
      src_tid: q
    });
  }

  if (result.status !== 0) {
    return { success: false, error: result.message || '旺店通API返回错误' };
  }

  const orders = (result.data && result.data.order) || [];
  if (orders.length === 0) {
    return { success: true, total: 0, orders: [] };
  }

  const parsedOrders = orders.map(o => {
    const shopInfo = parseShopInfo(o.shop_name);
    return {
      trade_no: o.trade_no || '',
      src_tids: o.src_tids || '',
      logistics_no: o.logistics_no || '',
      logistics_name: o.logistics_name || '',
      shop_name: o.shop_name || '',
      shop_no: o.shop_no || '',
      platform: shopInfo.platform,
      parsedShopName: shopInfo.shopName,
      trade_status: o.trade_status,
      trade_time: o.trade_time || '',
      consign_time: o.consign_time || '',
      stockout_no: o.stockout_no || '',
      goods_count: o.goods_count || 0,
      goods_amount: o.goods_amount || 0,
      receiver_area: o.receiver_area || '',
      receiver_name: o.receiver_name || '',
      receiver_mobile: o.receiver_mobile || ''
    };
  });

  return { success: true, total: parsedOrders.length, orders: parsedOrders };
}

/**
 * 格式化旺店通订单状态码为可读文本
 */
function formatTradeStatus(status) {
  return TRADE_STATUS_MAP[status] || ('状态' + status);
}

/**
 * 从描述文本中自动匹配旺店通订单
 * 遍历描述中的每个 token，提取可能的物流单号并查询旺店通，
 * 返回第一个匹配到的订单对象（或 null）。
 */
async function autoMatchWdtOrder(credentials, description) {
  const tokens = description.split(/\s+/);
  for (const token of tokens) {
    const cleaned = token.replace(/^[^\w]+/, '').replace(/[^\w]+$/, '');
    if (LOGISTICS_NO_REGEX.test(cleaned) && /\d/.test(cleaned)) {
      try {
        const wdtResult = await queryOrder(credentials, cleaned);
        if (wdtResult.success && wdtResult.orders && wdtResult.orders.length > 0) {
          return wdtResult.orders[0];
        }
      } catch (e) { /* 忽略旺店通查询错误 */ }
    }
  }
  return null;
}

/**
 * 将旺店通订单数据合并到提取结果中
 * 仅填充当前为空的字段，不覆盖已有值。
 * 返回更新后的 nonEmptyCount 和 missing。
 */
function mergeWdtData(headers, extractResult, wdtMatch) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const wdtProp = WDT_FIELD_MAP[h];
    if (wdtProp && wdtMatch[wdtProp] && (!extractResult.values[i] || !extractResult.values[i].trim())) {
      extractResult.values[i] = wdtMatch[wdtProp];
    }
  }
  extractResult.nonEmptyCount = extractResult.values.filter(v => v && v.trim()).length;
  extractResult.missing = headers.filter((h, i) => !extractResult.values[i] || !extractResult.values[i].trim());
}

module.exports = { queryOrder, callApi, calcSign, parseShopInfo, formatTradeStatus, autoMatchWdtOrder, mergeWdtData };
