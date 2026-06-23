const { chatJSON } = require('./llm');

function buildSystemPrompt(headers, tableName) {
  return `你是一个电商售后数据录入助手。
用户要向"${tableName}"写入一条新记录。
表格的列标题如下：
${JSON.stringify(headers)}

请从用户的自然语言描述中，提取每个列标题对应的值，以 JSON 格式输出。

【输出规则】
1. 只输出 JSON，不要输出任何解释、markdown 标记或多余文字。
2. JSON 的 key 必须与上面的列标题完全一致。
3. 如果某个列的值无法从描述中提取，对应值填空字符串 ""。
4. 不要编造未提及的信息。
5. 金额字段只填数字，不带"元"字。
6. 日期字段格式为 YYYY-MM-DD。

【示例】
列标题：["登记日期","店铺名称","平台","订单号","快递单号","理赔类型","货值","运费","备注"]
用户输入：华强北数码3C店 淘宝 订单号123456789 快递单号SF1234567890 丢件登记理赔货值399元 运费20元
输出：{"登记日期":"","店铺名称":"华强北数码3C店","平台":"淘宝","订单号":"123456789","快递单号":"SF1234567890","理赔类型":"丢件","货值":"399","运费":"20","备注":""}`;
}

async function extractRowData(llmConfig, headers, tableName, userDescription) {
  const systemPrompt = buildSystemPrompt(headers, tableName);

  const raw = await chatJSON(llmConfig, systemPrompt, userDescription);

  const values = headers.map(h => {
    const v = raw[h];
    if (v === undefined || v === null) return '';
    return String(v);
  });

  const missing = headers.filter(h => !raw[h] || String(raw[h]).trim() === '');

  return { values, missing, raw };
}

function buildPreviewText(headers, values) {
  const lines = [];
  for (let i = 0; i < headers.length; i++) {
    const val = values[i] || '(空)';
    lines.push(`  ${headers[i]}: ${val}`);
  }
  return lines.join('\n');
}

module.exports = { extractRowData, buildPreviewText, buildSystemPrompt };
