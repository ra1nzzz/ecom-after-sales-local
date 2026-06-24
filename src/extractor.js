const { chatJSON } = require('./llm');
const { FIELD_ALIASES, CLAIM_TYPES } = require('./constants');

function buildSystemPrompt(headers, tableName) {
  return '你是一个电商售后数据录入助手。\n' +
    '用户要向"' + tableName + '"写入一条新记录。\n' +
    '表格的列标题如下：\n' +
    JSON.stringify(headers) + '\n\n' +
    '【输入格式说明】\n' +
    '用户通常以空格分隔不同字段，字段名可能直接出现在输入中。\n' +
    '例如"订单号123456789"表示"订单号"列的值为"123456789"。\n' +
    '例如"快递单号 SF1234567890"表示"快递单号"列的值为"SF1234567890"。\n\n' +
    '【输出规则】\n' +
    '1. 只输出 JSON，不要输出任何解释、markdown 标记或多余文字。\n' +
    '2. JSON 的 key 必须与上面的列标题完全一致。\n' +
    '3. 如果某个列的值无法从描述中提取，对应值填空字符串 ""。\n' +
    '4. 不要编造未提及的信息。\n' +
    '5. 金额字段只填数字，不带"元"字。\n' +
    '6. 日期字段格式为 YYYY-MM-DD。\n' +
    '7. 识别输入中直接出现的字段名（如"订单号""快递单号""货值"等），提取其后的值。\n\n' +
    '【常见别名】\n' +
    '- "单号" → 快递单号\n' +
    '- "金额/价格" → 货值(元)\n' +
    '- "日期" → 登记日期\n' +
    '- "理赔" → 理赔类型（如"丢件理赔"表示理赔类型为"丢件"）\n' +
    '- "运费" → 运费(元)\n\n' +
    '【示例1】\n' +
    '列标题：["登记日期","店铺名称","平台","订单号","快递单号","理赔类型","货值(元)","运费(元)","备注"]\n' +
    '用户输入：华强北数码3C店 淘宝 订单号123456789 快递单号SF1234567890 丢件理赔货值399元 运费20元\n' +
    '输出：{"登记日期":"","店铺名称":"华强北数码3C店","平台":"淘宝","订单号":"123456789","快递单号":"SF1234567890","理赔类型":"丢件","货值(元)":"399","运费(元)":"20","备注":""}\n\n' +
    '【示例2】\n' +
    '列标题：["登记日期","快递单号","商品名称","正品数量","次品数量","次品备注","备注"]\n' +
    '用户输入：2026-06-23 快递单号YT9876543210 蓝牙耳机 正品2 次品1 包装破损\n' +
    '输出：{"登记日期":"2026-06-23","快递单号":"YT9876543210","商品名称":"蓝牙耳机","正品数量":"2","次品数量":"1","次品备注":"包装破损","备注":""}\n\n' +
    '【示例3】\n' +
    '列标题：["登记日期","店铺名称","平台","订单号","快递单号","理赔类型","货值(元)","运费(元)","备注"]\n' +
    '用户输入：9831745985570 丢件理赔54.9元 运费7元\n' +
    '输出：{"登记日期":"","店铺名称":"","平台":"","订单号":"","快递单号":"9831745985570","理赔类型":"丢件","货值(元)":"54.9","运费(元)":"7","备注":""}\n\n' +
    '【示例4】\n' +
    '列标题：["登记日期","店铺名称","平台","订单号","快递单号","理赔类型","货值(元)","运费(元)","备注"]\n' +
    '用户输入：店铺 和旭数码 平台 拼多多 订单号 9988776655 快递单号 JJD00998877 破损理赔 货值 158 运费 12\n' +
    '输出：{"登记日期":"","店铺名称":"和旭数码","平台":"拼多多","订单号":"9988776655","快递单号":"JJD00998877","理赔类型":"破损","货值(元)":"158","运费(元)":"12","备注":""}';
}

function cleanValue(val) {
  if (!val) return '';
  let v = val.trim();
  v = v.replace(/元$/, '');
  v = v.replace(/^[:：]+/, '');
  return v.trim();
}

// 去除表头中的括号后缀用于匹配，如 "货值(元)" → "货值"
function stripHeaderSuffix(h) {
  return h.replace(/[（(].*?[)）]\s*$/, '').trim();
}

function ruleBasedExtract(headers, description) {
  const result = {};
  headers.forEach(h => { result[h] = ''; });
  
  // 构建匹配表：原始表头 → 去后缀表头
  const headerMap = {};
  headers.filter(h => h && h.length > 0).forEach(h => {
    headerMap[h] = h;
    const stripped = stripHeaderSuffix(h);
    if (stripped !== h) headerMap[stripped] = h;
  });
  
  // 按长度降序排列（包括去后缀的版本）
  const sortedHeaders = Object.keys(headerMap).sort((a, b) => b.length - a.length);
  
  const aliases = FIELD_ALIASES;
  
  // 理赔类型关键词
  const claimTypes = CLAIM_TYPES;
  
  const tokens = description.split(/\s+/).filter(t => t.length > 0);
  let currentHeader = null;
  let valueParts = [];
  function flushCurrent() {
    if (currentHeader && valueParts.length > 0) {
      result[currentHeader] = cleanValue(valueParts.join(' '));
    }
    valueParts = [];
  }
  for (const token of tokens) {
    let matchedHeader = null;
    let remainder = '';

    // 1. 精确匹配表头
    for (const h of sortedHeaders) {
      if (token === h) { matchedHeader = headerMap[h]; remainder = ''; break; }
    }
    // 2. 表头前缀匹配（如 "快递单号SF123" → 快递单号 + SF123）
    if (!matchedHeader) {
      for (const h of sortedHeaders) {
        if (token.length > h.length && token.startsWith(h)) {
          matchedHeader = headerMap[h]; remainder = token.substring(h.length); break;
        }
      }
    }
    // 3. 别名匹配
    if (!matchedHeader) {
      for (const [alias, target] of Object.entries(aliases)) {
        if (headers.includes(target)) {
          if (token === alias) { matchedHeader = target; remainder = ''; break; }
          if (token.length > alias.length && token.startsWith(alias)) {
            matchedHeader = target; remainder = token.substring(alias.length); break;
          }
        }
      }
    }
    // 4. 分隔符匹配（如 "货值:399"）
    if (!matchedHeader) {
      for (const h of sortedHeaders) {
        const idx = token.indexOf(h);
        if (idx >= 0 && idx + h.length < token.length) {
          const after = token.substring(idx + h.length);
          if (/^[:：\-—=]/.test(after)) {
            matchedHeader = headerMap[h]; remainder = after.replace(/^[:：\-—=]+/, ''); break;
          }
        }
      }
    }
    // 5. 特殊模式：理赔类型+金额（如 "丢件理赔54.9元"）
    if (!matchedHeader) {
      for (const ct of claimTypes) {
        if (token.includes(ct)) {
          const claimHeader = headers.find(h => h.includes('理赔类型'));
          if (claimHeader) {
            result[claimHeader] = ct;
            // 提取剩余部分中的金额
            const rest = token.replace(ct, '').replace('理赔', '');
            const amountMatch = rest.match(/(\d+\.?\d*)/);
            if (amountMatch) {
              const amountHeader = headers.find(h => h.includes('货值'));
              if (amountHeader) result[amountHeader] = amountMatch[1];
            }
            matchedHeader = null; // 已处理，不进入常规流程
            break;
          }
        }
      }
    }
    // 6. 特殊模式：字段名+数字（如 "运费7元" 或 "运费7"）
    if (!matchedHeader) {
      for (const h of sortedHeaders) {
        const stripped = stripHeaderSuffix(headerMap[h] || h);
        if (stripped.length >= 2 && token.startsWith(stripped) && token.length > stripped.length) {
          const after = token.substring(stripped.length);
          if (/^\d+\.?\d*元?$/.test(after)) {
            matchedHeader = headerMap[h] || h; remainder = after; break;
          }
        }
      }
    }
    if (matchedHeader) {
      flushCurrent();
      currentHeader = matchedHeader;
      if (remainder) valueParts.push(remainder);
    } else if (currentHeader) {
      valueParts.push(token);
    }
  }
  flushCurrent();
  return result;
}

async function extractRowData(llmConfig, headers, tableName, userDescription) {
  const t0 = Date.now();
  let method = 'none';
  let raw = null;
  let llmError = null;
  const llmAvailable = (llmConfig.apiKey && llmConfig.apiKey.trim()) || llmConfig.provider === 'ollama';
  if (llmAvailable) {
    try {
      const systemPrompt = buildSystemPrompt(headers, tableName);
      raw = await chatJSON(llmConfig, systemPrompt, userDescription);
      method = 'llm';
    } catch (err) {
      llmError = err.message;
    }
  } else {
    llmError = 'LLM API Key 未配置';
  }
  if (!raw) {
    raw = ruleBasedExtract(headers, userDescription);
    method = 'rule';
  } else {
    // LLM返回结果后，仅当存在空字段时才用rule-based补充，避免不必要的计算
    const hasEmpty = headers.some(h => !raw[h] || String(raw[h]).trim() === '');
    if (hasEmpty) {
      const ruleResult = ruleBasedExtract(headers, userDescription);
      for (const h of headers) {
        if ((!raw[h] || String(raw[h]).trim() === '') && ruleResult[h] && String(ruleResult[h]).trim()) {
          raw[h] = ruleResult[h];
        }
      }
      method = 'llm+rule';
    } else {
      method = 'llm';
    }
  }
  const values = headers.map(h => {
    const v = raw[h];
    if (v === undefined || v === null) return '';
    return String(v);
  });
  const missing = headers.filter(h => !raw[h] || String(raw[h]).trim() === '');
  const parseTime = Date.now() - t0;
  const nonEmptyCount = values.filter(v => v && v.trim()).length;
  return { values, missing, raw, method, parseTime, llmError, nonEmptyCount };
}

function buildPreviewText(headers, values) {
  const lines = [];
  for (let i = 0; i < headers.length; i++) {
    const val = values[i] || '(空)';
    lines.push(`  ${headers[i]}: ${val}`);
  }
  return lines.join('\n');
}

module.exports = { extractRowData, buildPreviewText, buildSystemPrompt, ruleBasedExtract, cleanValue };
