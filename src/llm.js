const OpenAI = require('openai');

// 客户端缓存：相同 provider+baseUrl+apiKey 复用 OpenAI 实例，减少 TLS 握手开销
const clientCache = new Map();

function createLLMClient(llmConfig) {
  if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
    throw new Error(`LLM API Key 未配置 (provider: ${llmConfig.provider})`);
  }

  const cacheKey = `${llmConfig.provider}-${llmConfig.baseUrl}-${llmConfig.apiKey || 'ollama'}`;
  if (clientCache.has(cacheKey)) {
    const cached = clientCache.get(cacheKey);
    // 模型名可能变更，更新缓存中的 model
    cached.model = llmConfig.model;
    return cached;
  }

  const client = new OpenAI({
    apiKey: llmConfig.apiKey || 'ollama',
    baseURL: llmConfig.baseUrl,
    timeout: 30000,
    maxRetries: 2
  });

  const clientObj = {
    client,
    model: llmConfig.model,
    provider: llmConfig.provider
  };
  clientCache.set(cacheKey, clientObj);
  return clientObj;
}

async function chatJSON(llmConfig, systemPrompt, userMessage) {
  const { client, model } = createLLMClient(llmConfig);

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 2048
  });

  const content = completion.choices[0].message.content;

  if (!content || !content.trim()) {
    throw new Error('LLM 返回空内容，请重试');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e2) {
        throw new Error('LLM 输出无法解析为 JSON: ' + content.substring(0, 200));
      }
    } else {
      throw new Error('LLM 输出无法解析为 JSON: ' + content.substring(0, 200));
    }
  }

  return parsed;
}

async function testConnection(llmConfig) {
  try {
    const { client, model } = createLLMClient(llmConfig);
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: '请回复"ok"' }],
      max_tokens: 10,
      temperature: 0
    });
    const text = completion.choices[0].message.content;
    return { ok: true, message: `连接成功，模型回复: ${text}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { createLLMClient, chatJSON, testConnection };
