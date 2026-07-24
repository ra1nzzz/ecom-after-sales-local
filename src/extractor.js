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
    '【字段值约束 - 严格遵守】\n' +
    '- 店铺名称：必须是店铺/商家的名称（如"华强北数码3C店"），不要填入状态描述（如"平台已退"、"已退款"等），也不要填入"顾客"等非店铺名。\n' +
    '- 平台：必须是电商平台名称（如"淘宝"、"拼多多"、"京东"、"抖音"等），不要填入订单状态。\n' +
    '- 理赔类型：只填类型关键词（如"丢件"、"破损"、"退件"），不要带"理赔"二字。\n' +
    '- 订单号/快递单号：只填纯数字或字母数字组合，不要带中文描述。\n' +
    '- 货值/运费：只填数字（可带小数），不要带"元"字或其他文字。\n' +
    '- 如果输入中的某个词无法明确对应到某个字段，宁可留空也不要猜测填入。\n\n' +
    '【快递单号识别规则 - 严格遵守】\n' +
    '当输入中没有明确标注"订单号"或"快递单号"时，开头的纯数字串优先识别为快递单号，而非订单号。\n' +
    '常见快递单号格式：\n' +
    '- 邮政新单号：13位纯数字（如1377342763809）\n' +
    '- 顺丰：SF开头+数字（如SF1234567890）\n' +
    '- 圆通：YT开头+数字（如YT9876543210）\n' +
    '- 申通：STO开头+数字 或 纯数字\n' +
    '- 中通：ZTO开头+数字 或 纯数字\n' +
    '- 韵达：YD开头+数字 或 纯数字\n' +
    '- 极兔：JT开头+数字\n' +
    '- 京东：JD开头+数字\n' +
    '- 德邦：DBS开头+数字\n' +
    '注意：13位纯数字（如1377342763809）是邮政新单号格式，应填入快递单号，不要填入订单号。\n' +
    '只有当输入明确标注"订单号"时，才将对应数字填入订单号字段。\n\n' +
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
    '输出：{"登记日期":"","店铺名称":"和旭数码","平台":"拼多多","订单号":"9988776655","快递单号":"JJD00998877","理赔类型":"破损","货值(元)":"158","运费(元)":"12","备注":""}\n\n' +
    '【示例5 - 错误示范】\n' +
    '列标题：["登记日期","店铺名称","平台","订单号","快递单号","理赔类型","货值(元)","运费(元)","备注"]\n' +
    '用户输入：平台已退 9831745985570\n' +
    '输出：{"登记日期":"","店铺名称":"","平台":"","订单号":"","快递单号":"9831745985570","理赔类型":"","货值(元)":"","运费(元)":"","备注":"平台已退"}\n' +
    '注意："平台已退"是状态描述不是店铺名称，放入备注栏。';
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
  
  // ========== 预处理：从无空格消息中提取开头的长数字串作为快递单号 ==========
  // 如 "1377342763809快递联系顾客漏油破损拒收登记理赔38.5元"
  const logisticsHeader = headers.find(h => {
    const name = (h || '').trim();
    return name === '快递单号' || name === '物流单号';
  });
  if (logisticsHeader) {
    // 匹配开头的纯数字(>=10位)或字母+数字组合(如SF1234567890)
    const leadingMatch = description.match(/^(\d{10,}|[A-Za-z]{2,4}\d{8,})/);
    if (leadingMatch) {
      result[logisticsHeader] = leadingMatch[1];
      // 从描述中移除已提取的单号，避免后续误匹配
      description = description.substring(leadingMatch[1].length);
    } else {
      // 开头没有单号时，扫描所有token找快递单号（如"和旭数码 拼多多 9818039366588 破损理赔60.3元"）
      const allTokens = description.split(/[\s，,、；;]+/).filter(t => t.length > 0);
      for (const t of allTokens) {
        // 纯数字10位以上 或 字母2-4位+数字8位以上
        if (/^\d{10,}$/.test(t) || /^[A-Za-z]{2,4}\d{8,}$/.test(t)) {
          result[logisticsHeader] = t;
          description = description.replace(t, ' ');
          break;
        }
      }
    }
  }
  
  const tokens = description.split(/[\s，,、；;]+/).filter(t => t.length > 0);
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
          const afterHeader = token.substring(h.length);
          // 前缀后必须跟纯数字/字母数字组合（如"SF123"），不能跟中文（如"运费7元丢件理赔60.3元"）
          if (/^[A-Za-z0-9]{2,}$/.test(afterHeader) || /^\d+\.?\d*元?$/.test(afterHeader)) {
            matchedHeader = headerMap[h]; remainder = afterHeader; break;
          }
        }
      }
    }
    // 3. 别名匹配
    if (!matchedHeader) {
      for (const [alias, target] of Object.entries(aliases)) {
        if (headers.includes(target)) {
          if (token === alias) { matchedHeader = target; remainder = ''; break; }
          if (token.length > alias.length && token.startsWith(alias)) {
            const afterAlias = token.substring(alias.length);
            // 别名后必须跟纯数字/数字+元（如"运费7"/"运费7元"），不能跟中文（如"运费7元丢件理赔60.3元"）
            if (/^\d+\.?\d*元?$/.test(afterAlias)) {
              matchedHeader = target; remainder = afterAlias; break;
            }
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
    // 5. 特殊模式：理赔类型+金额（如 "丢件理赔54.9元" 或 "就地销毁登记理赔60.3元"）
    if (!matchedHeader) {
      let claimMatched = false;
      for (const ct of claimTypes) {
        if (token.includes(ct)) {
          const claimHeader = headers.find(h => h.includes('理赔类型'));
          if (claimHeader) {
            result[claimHeader] = ct;
            // 提取剩余部分中的金额（先移除运费部分，避免运费被误识为货值）
            const rest = token.replace(ct, '').replace('理赔', '').replace(/运费\d+\.?\d*元?/g, '');
            // 优先匹配带"元"的金额（如"38.5元"），避免误匹配快递单号
            const amountWithUnit = rest.match(/(\d+\.?\d*)元/);
            const amountMatch = amountWithUnit || rest.match(/(\d+\.?\d*)$/);
            if (amountMatch) {
              const amountHeader = headers.find(h => h.includes('货值'));
              if (amountHeader) result[amountHeader] = amountMatch[1];
            }
            claimMatched = true;
            break;
          }
        }
      }
      // 5b. 未匹配到具体理赔类型，但包含"理赔"关键字 → 仍尝试提取金额
      if (!claimMatched && token.includes('理赔')) {
        const rest = token.replace('理赔', '').replace('登记', '').replace(/运费\d+\.?\d*元?/g, '');
        const amountWithUnit = rest.match(/(\d+\.?\d*)元/);
        const amountMatch = amountWithUnit || rest.match(/(\d+\.?\d*)$/);
        if (amountMatch) {
          const amountHeader = headers.find(h => h.includes('货值'));
          if (amountHeader && !result[amountHeader]) result[amountHeader] = amountMatch[1];
        }
      }
      if (claimMatched) {
        matchedHeader = null; // 已处理，不进入常规流程
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

  // ========== 全局兜底：运费提取（先于金额，便于排除） ==========
  const freightHeader = headers.find(h => h.includes('运费'));
  let freightValue = '';
  if (freightHeader && (!result[freightHeader] || !String(result[freightHeader]).trim())) {
    const freightMatch = description.match(/运费\s*(\d+\.?\d*)/);
    if (freightMatch) {
      freightValue = freightMatch[1];
      result[freightHeader] = freightValue;
    }
  }

  // ========== 全局兜底：金额提取 ==========
  // 如果货值字段仍为空，扫描描述中所有"数字元"模式
  const amountHeader = headers.find(h => h.includes('货值') || h.includes('金额') || h.includes('价格'));
  if (amountHeader && (!result[amountHeader] || !String(result[amountHeader]).trim())) {
    const allAmounts = description.match(/(\d+\.?\d*)元/g);
    if (allAmounts && allAmounts.length > 0) {
      // 过滤掉已提取为运费的金额，避免运费被误填为货值
      const candidates = allAmounts
        .map(a => a.replace('元', ''))
        .filter(a => a !== freightValue);
      if (candidates.length > 0) {
        result[amountHeader] = candidates[candidates.length - 1];
      }
    }
  }

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
  // 自动填充登记日期为当天日期（若表头包含且值为空）
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dateHeader = headers.find(h => h === '登记日期' || h.includes('日期'));
  if (dateHeader && (!raw[dateHeader] || String(raw[dateHeader]).trim() === '')) {
    raw[dateHeader] = todayStr;
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
