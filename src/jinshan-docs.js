/**
 * jinshan-docs.js - 金山文档（WPS开放平台）DBSheet 适配器
 *
 * 通过 WPS 开放平台 OpenAPI（https://openapi.wps.cn）读写多维表格（DBSheet）。
 * 鉴权方式：OAuth Bearer Token + KSO-1 HMAC-SHA256 签名。
 *
 * providerConfig = { appId, appKey, accessToken }
 *   - accessToken：用户在 WPS 开放平台 OAuth 流程中获取，配置于设置中
 *   - appId / appKey：应用凭证，用于 KSO-1 签名
 */

const https = require('https');
const crypto = require('crypto');
const { makeGetDocState, makeClearCache, MAX_COL_COUNT, REQUEST_TIMEOUT, csvEscape, csvRow, splitCsvLines, parseCsvLine } = require('./shared-docs');

const BASE_HOST = 'openapi.wps.cn';

// 文档状态管理（使用共享状态工厂）
const getDocState = makeGetDocState({ schema: null, schemaSheetId: null });
const clearCache = makeClearCache(getDocState, (state) => {
  state.schema = null;
  state.schemaSheetId = null;
});

/**
 * 初始化适配器（WPS OpenAPI 无需初始化会话，此处为 no-op）
 */
async function init(providerConfig, state) {
  // no-op：WPS OpenAPI 基于无状态 HTTP 请求，无需建立会话
}

/* =========================================================================
 * KSO-1 签名与请求封装
 * ========================================================================= */

/**
 * 生成 KSO-1 签名
 *
 * signature = Base64( HMAC-SHA256( appKey, "KSO-1" + Method + RequestURI + ContentType + KsoDate + sha256(RequestBody) ) )
 *
 * @param {string} appKey      应用密钥
 * @param {string} method      HTTP 方法大写（GET / POST / PUT）
 * @param {string} requestURI  请求路径（含查询字符串），如 "/v7/coop/dbsheet/xxx/sheets"
 * @param {string} contentType 内容类型，POST 为 "application/json"，GET 为空字符串
 * @param {string} ksoDate     RFC1123 格式日期，与 X-Kso-Date 头一致
 * @param {string} requestBody 请求体字符串，GET 请求传空字符串
 * @returns {string} Base64 编码的签名值
 */
function ksoSign(appKey, method, requestURI, contentType, ksoDate, requestBody) {
  const methodUpper = method.toUpperCase();
  // 请求体的 SHA-256 十六进制摘要；GET 无请求体时使用空字符串
  const bodyHash = requestBody
    ? crypto.createHash('sha256').update(requestBody, 'utf8').digest('hex')
    : '';
  const data = 'KSO-1' + methodUpper + requestURI + (contentType || '') + ksoDate + bodyHash;
  return crypto.createHmac('sha256', appKey).update(data, 'utf8').digest('base64');
}

/**
 * 发送带 KSO-1 签名鉴权的 HTTPS 请求
 *
 * 自动附加三个鉴权头：
 *   - Authorization: Bearer {accessToken}
 *   - X-Kso-Authorization: KSO-1 {appId}:{signature}
 *   - X-Kso-Date: {RFC1123 date}
 *
 * @param {object} providerConfig { appId, appKey, accessToken }
 * @param {string} method  HTTP 方法（GET / POST / PUT）
 * @param {string} path    请求路径（含查询字符串）
 * @param {object|string} [body]  请求体（POST/PUT 时传入对象或字符串，GET 时忽略）
 * @returns {Promise<object|string>} 解析后的 JSON 响应；若无法解析则返回原始文本
 */
function makeRequest(providerConfig, method, path, body) {
  return new Promise((resolve, reject) => {
    const { appId, appKey, accessToken } = providerConfig;
    const methodUpper = method.toUpperCase();
    const isGet = methodUpper === 'GET';

    const contentType = isGet ? '' : 'application/json';
    const requestBody = isGet ? '' : (body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '');

    const ksoDate = new Date().toUTCString();
    const signature = ksoSign(appKey, methodUpper, path, contentType, ksoDate, requestBody);

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-Kso-Authorization': `KSO-1 ${appId}:${signature}`,
      'X-Kso-Date': ksoDate,
      'Host': BASE_HOST
    };
    if (!isGet) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(requestBody);
    }

    const options = {
      hostname: BASE_HOST,
      port: 443,
      path: path,
      method: methodUpper,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`WPS API 返回错误状态码 ${res.statusCode}: ${data.substring(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          // 非 JSON 响应（如纯文本），直接返回原始内容
          resolve(data);
        }
      });
    });

    req.on('error', (e) => reject(new Error('WPS API 请求失败: ' + e.message)));
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('WPS API 请求超时'));
    });

    if (!isGet && requestBody) {
      req.write(requestBody);
    }
    req.end();
  });
}

/* =========================================================================
 * DBSheet 业务接口
 * ========================================================================= */

/**
 * 获取工作表列表
 *
 * 优先尝试 GET /v7/coop/dbsheet/{fileId}/sheets；
 * 若接口不可用（HTTP 错误或业务码非 0），回退为单个虚拟工作表。
 *
 * @returns {Promise<Array<{sheet_id, sheet_name, row_count, col_count}>>}
 */
async function getSheetList(providerConfig, state, fileId) {
  try {
    const resp = await makeRequest(providerConfig, 'GET', `/v7/coop/dbsheet/${fileId}/sheets`);
    if (resp && resp.code === 0 && resp.data) {
      const rawSheets = resp.data.sheets || resp.data.list || [];
      if (Array.isArray(rawSheets) && rawSheets.length > 0) {
        const sheets = rawSheets.map(s => ({
          sheet_id: s.sheet_id || s.id || '',
          sheet_name: s.sheet_name || s.name || s.title || '',
          row_count: s.row_count || s.rowCount || 1000,
          col_count: s.col_count || s.colCount || 10
        }));
        if (sheets[0] && sheets[0].sheet_id) {
          state.sheetId = sheets[0].sheet_id;
        }
        return sheets;
      }
    }
  } catch (err) {
    // 鉴权/签名错误不应被静默吞掉
    if (err.statusCode === 401 || err.statusCode === 403 || (err.message && err.message.includes('鉴权'))) {
      throw new Error(`金山文档鉴权失败: ${err.message}，请检查 App ID/App Key/Access Token 配置`);
    }
    // 其他错误（接口不可用等）- 回退到虚拟工作表
    console.warn('jinshan getSheetList: 接口不可用，使用虚拟工作表:', err.message);
  }

  // 回退到虚拟工作表
  const dummy = [{
    sheet_id: fileId,
    sheet_name: 'Sheet1',
    row_count: 1000,
    col_count: 10
  }];
  state.sheetId = fileId;
  return dummy;
}

/**
 * 获取多维表格的字段定义（schema），结果缓存于 state.schema
 *
 * POST /v7/coop/dbsheet/{fileId}/sheets/{sheetId}/get-schema
 *
 * @returns {Promise<Array<{field_id, field_name}>>}
 */
async function getSchema(providerConfig, state, fileId, sheetId) {
  // 已缓存且属于同一工作表时直接复用
  if (state.schema && state.schemaSheetId === sheetId) {
    return state.schema;
  }

  const resp = await makeRequest(
    providerConfig,
    'POST',
    `/v7/coop/dbsheet/${fileId}/sheets/${sheetId}/get-schema`,
    {}
  );

  if (!resp || resp.code !== 0) {
    const msg = (resp && (resp.msg || resp.message)) || JSON.stringify(resp);
    throw new Error(`获取 schema 失败: ${msg}`);
  }

  // 兼容多种可能的响应结构
  const fields =
    (resp.data && resp.data.fields) ||
    (resp.data && resp.data.schema && resp.data.schema.fields) ||
    (resp.data && resp.data.columns) ||
    [];

  const schema = fields.map(f => ({
    field_id: f.field_id || f.id || '',
    field_name: f.field_name || f.name || f.title || ''
  }));

  state.schema = schema;
  state.schemaSheetId = sheetId;
  return schema;
}

/**
 * 读取记录并转换为 CSV 字符串
 *
 * POST /v7/coop/dbsheet/{fileId}/sheets/{sheetId}/records
 * 支持分页：当返回的 page_token 非空时继续拉取。
 *
 * CSV 格式：首行为字段名（来自 schema），后续每行为一条记录的字段值。
 *
 * @returns {Promise<string>} CSV 文本
 */
async function readSheetCsv(providerConfig, state, fileId, sheetId, rowCount, colCount, startRow = 0) {
  const schema = await getSchema(providerConfig, state, fileId, sheetId);
  const fieldNames = schema.map(f => f.field_name);

  // 分页拉取全部记录
  const allRecords = [];
  let pageToken = '';
  const pageSize = 500;
  const MAX_PAGES = 200;
  let pageCount = 0;

  do {
    const body = { page_size: pageSize, page_token: pageToken };
    const resp = await makeRequest(
      providerConfig,
      'POST',
      `/v7/coop/dbsheet/${fileId}/sheets/${sheetId}/records`,
      body
    );

    if (!resp || resp.code !== 0) {
      const msg = (resp && (resp.msg || resp.message)) || JSON.stringify(resp);
      throw new Error(`读取记录失败: ${msg}`);
    }

    const records = (resp.data && resp.data.records) || [];
    for (const rec of records) {
      // fields 可能为 JSON 字符串或对象
      let fieldsObj = {};
      if (rec.fields) {
        if (typeof rec.fields === 'string') {
          try { fieldsObj = JSON.parse(rec.fields); } catch (e) { fieldsObj = {}; }
        } else {
          fieldsObj = rec.fields;
        }
      }
      allRecords.push(fieldsObj);
    }

    pageToken = (resp.data && resp.data.page_token) || '';
    pageCount++;
  } while (pageToken && pageCount < MAX_PAGES);
  if (pageToken) console.warn('jinshan readSheetCsv: reached max pages, data may be incomplete');

  // 拼装 CSV：首行表头 + 数据行
  const lines = [];
  lines.push(csvRow(fieldNames));
  for (const fieldsObj of allRecords) {
    lines.push(csvRow(recordToRow(fieldsObj, schema)));
  }
  return lines.join('\n');
}

/**
 * 写入一行记录（创建新记录）
 *
 * POST /v7/coop/dbsheet/{fileId}/sheets/{sheetId}/records/create
 * 将 values 数组按 schema 顺序映射为字段名 → 值，构造 fields_value JSON 字符串。
 *
 * @param {object} providerConfig
 * @param {string} fileId
 * @param {string} sheetId
 * @param {number} startRow    起始行（DBSheet 为追加式写入，此参数保留以兼容接口）
 * @param {Array}  values      按字段顺序排列的值数组
 * @returns {Promise<{updateNum}>}
 */
async function writeRow(providerConfig, state, fileId, sheetId, startRow, values) {
  const schema = await getSchema(providerConfig, state, fileId, sheetId);

  // 将 values 数组按 schema 顺序映射为 { 字段名: 值 }
  const fieldsValue = {};
  const count = Math.min(values.length, schema.length);
  for (let i = 0; i < count; i++) {
    const fieldName = schema[i].field_name;
    const val = values[i];
    fieldsValue[fieldName] = (val === undefined || val === null) ? '' : String(val);
  }

  const body = {
    prefer_id: false,
    records: [{ fields_value: JSON.stringify(fieldsValue) }]
  };

  const resp = await makeRequest(
    providerConfig,
    'POST',
    `/v7/coop/dbsheet/${fileId}/sheets/${sheetId}/records/create`,
    body
  );

  if (!resp || resp.code !== 0) {
    const msg = (resp && (resp.msg || resp.message)) || JSON.stringify(resp);
    throw new Error(`写入记录失败: ${msg}`);
  }

  const created = (resp.data && resp.data.records) || [];
  return { updateNum: created.length || 1 };
}

/**
 * 查找下一个空行位置（金山文档专用）
 *
 * 金山 DBSheet 为追加式写入，readSheetCsv 返回全量记录。
 * 这里一次读取全量 CSV，在内存中扫描第一个全空行。
 * 避免外层 findNextEmptyRow 按 50 行批次反复调用 readSheetCsv 导致全量拉取 N 次。
 *
 * @returns {Promise<number>} 下一个空行的行号（0-based，含表头行）
 */
async function findEmptyRow(providerConfig, state, fileId, sheetId, startRow, colCount, maxRowCount) {
  const csv = await readSheetCsv(providerConfig, state, fileId, sheetId, maxRowCount, colCount);
  const lines = splitCsvLines(csv);
  for (let i = Math.max(1, startRow); i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.every(c => !c || !c.trim())) {
      return i;
    }
  }
  return lines.length; // 无空行，追加到末尾
}

/* =========================================================================
 * CSV / 记录转换辅助函数
 * ========================================================================= */

/**
 * 将一条记录的字段对象转为按 schema 顺序排列的值数组
 * 兼容字段名或字段 ID 作为 key
 */
function recordToRow(fieldsObj, schema) {
  return schema.map(f => {
    let val = fieldsObj[f.field_name];
    if (val === undefined && f.field_id) {
      val = fieldsObj[f.field_id];
    }
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
}

module.exports = {
  init,
  getSheetList,
  readSheetCsv,
  writeRow,
  findEmptyRow,
  getDocState,
  clearCache,
  // 辅助函数（供测试与复用）
  getSchema,
  ksoSign,
  makeRequest,
  recordToRow,
  csvRow
};
