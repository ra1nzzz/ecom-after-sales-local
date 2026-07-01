const https = require('https');

// 读取单元格数据时限制的最大列数，防止请求过大
const MAX_COL_COUNT = 10;

// 飞书开放平台域名
const FEISHU_HOST = 'open.feishu.cn';

// 租户访问令牌缓存（模块级，跨请求共享）
// token 有效期 2 小时，剩余不足 5 分钟时刷新
const tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null;

// 提前刷新阈值：5 分钟
const TOKEN_REFRESH_THRESHOLD = 5 * 60 * 1000;

// 每个文档的缓存状态
const docStates = new Map();

function getDocState(fileId) {
  if (!docStates.has(fileId)) {
    docStates.set(fileId, {
      cachedData: null,
      cacheTimestamp: 0,
      cacheLoading: false
    });
  }
  return docStates.get(fileId);
}

/**
 * 清除指定文档的数据缓存（不重置令牌缓存）
 */
function clearCache(fileId) {
  const state = getDocState(fileId);
  state.cachedData = null;
  state.cacheTimestamp = 0;
}

/**
 * 列索引（0-based）转 Excel 列字母
 * 0→A, 1→B, 25→Z, 26→AA, 27→AB ...
 */
function colToLetter(colIndex) {
  let letter = '';
  let idx = colIndex;
  while (idx >= 0) {
    letter = String.fromCharCode(65 + (idx % 26)) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

/**
 * 通用 HTTPS 请求封装（飞书开放平台）
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径（含 query string）
 * @param {object} headers - 额外请求头
 * @param {object|null} body - 请求体（POST/PUT），GET 传 null
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
function request(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    let bodyData = null;

    if (body !== undefined && body !== null) {
      bodyData = JSON.stringify(body);
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const options = {
      hostname: FEISHU_HOST,
      port: 443,
      path: path,
      method: method,
      headers: reqHeaders
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`飞书 API 返回错误状态码 ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('解析飞书响应失败: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(new Error('请求飞书失败: ' + e.message)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('请求飞书超时')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

/**
 * 获取租户访问令牌（tenant_access_token），带缓存
 * 令牌有效期 2 小时，剩余不足 5 分钟或已过期时自动刷新
 * 并发请求通过 tokenPromise 去重，避免重复获取
 */
async function getTenantAccessToken(providerConfig) {
  const now = Date.now();
  // 缓存有效且剩余时间超过刷新阈值
  if (tokenCache.token && (tokenCache.expireAt - now) > TOKEN_REFRESH_THRESHOLD) {
    return tokenCache.token;
  }
  // 已有正在进行的获取请求，复用其 Promise
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    try {
      const resp = await request(
        'POST',
        '/open-apis/auth/v3/tenant_access_token/internal',
        { 'Content-Type': 'application/json; charset=utf-8' },
        { app_id: providerConfig.appId, app_secret: providerConfig.appSecret }
      );
      if (resp.code !== 0 || !resp.tenant_access_token) {
        throw new Error(
          `获取飞书 tenant_access_token 失败: code=${resp.code}, msg=${resp.msg || JSON.stringify(resp).substring(0, 200)}`
        );
      }
      tokenCache.token = resp.tenant_access_token;
      tokenCache.expireAt = Date.now() + (resp.expire || 7200) * 1000;
      return tokenCache.token;
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

/**
 * 带认证的请求封装：自动附加 Authorization 头
 * 遇到令牌过期/无效错误（99991661/99991663）时刷新令牌并重试一次
 */
async function authedRequest(providerConfig, method, path, body) {
  const token = await getTenantAccessToken(providerConfig);
  const headers = { 'Authorization': `Bearer ${token}` };
  let resp = await request(method, path, headers, body);

  // 令牌过期或无效：刷新后重试一次
  if (resp.code === 99991661 || resp.code === 99991663) {
    tokenCache.token = null;
    tokenCache.expireAt = 0;
    const newToken = await getTenantAccessToken(providerConfig);
    headers['Authorization'] = `Bearer ${newToken}`;
    resp = await request(method, path, headers, body);
  }
  return resp;
}

/**
 * 初始化适配器（空操作）
 * 令牌在首次请求时惰性获取，无需提前初始化
 */
async function init(providerConfig, state) {
  // no-op
}

/**
 * 获取电子表格的工作表列表
 * @returns {Promise<Array<{sheet_id, sheet_name, row_count, col_count}>>}
 */
async function getSheetList(providerConfig, state, fileId) {
  const resp = await authedRequest(
    providerConfig,
    'GET',
    `/open-apis/sheets/v3/spreadsheets/${fileId}/sheets/query`,
    null
  );
  if (resp.code !== 0) {
    throw new Error(`获取飞书工作表列表失败: code=${resp.code}, msg=${resp.msg || ''}`);
  }
  const sheets = (resp.data && resp.data.sheets) || [];
  return sheets.map(s => ({
    sheet_id: s.sheet_id,
    sheet_name: s.title,
    row_count: s.grid_properties ? s.grid_properties.row_count : 0,
    col_count: s.grid_properties ? s.grid_properties.column_count : 0
  }));
}

/**
 * 将 CSV 单元格值进行转义：包含逗号、引号、换行时用双引号包裹
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * 将二维数组转换为 CSV 字符串
 */
function arrayToCsv(rows) {
  return rows.map(row =>
    (row || []).map(cell => csvEscape(cell)).join(',')
  ).join('\n');
}

/**
 * 读取工作表指定区域数据并返回 CSV 字符串
 * @param {number} startRow - 起始行（0-based）
 * @returns {Promise<string>} CSV 字符串
 */
async function readSheetCsv(providerConfig, state, fileId, sheetId, rowCount, colCount, startRow = 0) {
  // 列数限制为 min(colCount, MAX_COL_COUNT)，至少 1 列
  const cols = Math.max(1, Math.min(colCount, MAX_COL_COUNT));
  const startColLetter = 'A';
  const endColLetter = colToLetter(cols - 1);
  // 飞书行号为 1-based：startRow(0-based) + 1
  const startRow1Based = startRow + 1;
  const endRow = rowCount;
  const range = `${sheetId}!${startColLetter}${startRow1Based}:${endColLetter}${endRow}`;

  const resp = await authedRequest(
    providerConfig,
    'GET',
    `/open-apis/sheets/v2/spreadsheets/${fileId}/values/${encodeURIComponent(range)}?valueRenderOption=ToString`,
    null
  );
  if (resp.code !== 0) {
    throw new Error(`读取飞书表格数据失败: code=${resp.code}, msg=${resp.msg || ''}`);
  }
  const values = (resp.data && resp.data.valueRange && resp.data.valueRange.values) || [];
  return arrayToCsv(values);
}

/**
 * 向工作表写入单行数据
 * @param {number} startRow - 起始行（0-based，内部转换为飞书 1-based）
 * @param {Array} values - 待写入的值数组
 * @returns {Promise<{updateNum}>} 更新的单元格数量
 */
async function writeRow(providerConfig, fileId, sheetId, startRow, values) {
  const colCount = Math.max(1, values.length);
  const endColLetter = colToLetter(colCount - 1);
  // 飞书行号为 1-based：startRow(0-based) + 1，单行写入起止行相同
  const row1Based = startRow + 1;
  const range = `${sheetId}!A${row1Based}:${endColLetter}${row1Based}`;

  const body = {
    valueRange: {
      range: range,
      // null/undefined 转为空字符串，其余保留原类型
      values: [values.map(v => (v === null || v === undefined) ? '' : v)]
    }
  };

  const resp = await authedRequest(
    providerConfig,
    'PUT',
    `/open-apis/sheets/v2/spreadsheets/${fileId}/values`,
    body
  );
  if (resp.code !== 0) {
    throw new Error(`写入飞书表格失败: code=${resp.code}, msg=${resp.msg || ''}`);
  }
  const updatedCells = (resp.data && resp.data.updatedCells) || values.length;
  return { updateNum: updatedCells };
}

module.exports = {
  init,
  getSheetList,
  readSheetCsv,
  readSheetHeaders: readSheetCsv,
  writeRow,
  getDocState,
  clearCache,
  colToLetter,
  getTenantAccessToken,
  arrayToCsv
};
