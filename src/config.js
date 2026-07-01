const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');

const DEFAULT_CONFIG = {
  documents: [],
  queryDefaultDocumentId: '',
  writeDefaultDocumentId: '',
  tencentDocs: {
    apiKey: '',
    mcpUrl: 'https://docs.qq.com/openapi/mcp'
  },
  feishuDocs: {
    appId: '',
    appSecret: ''
  },
  jinshanDocs: {
    appId: '',
    appKey: '',
    accessToken: ''
  },
  llm: {
    provider: 'deepseek',
    customProviderName: '',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  wangdian: {
    sid: '',
    key: '',
    secret: '',
    salt: ''
  },
  cache: {
    ttl: 300000,
    autoRefreshInterval: 1800000
  }
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const userConfig = JSON.parse(raw);

      // 向后兼容：旧版 defaultDocumentId 拆分为查询/写入默认文档
      if (userConfig.defaultDocumentId && !userConfig.queryDefaultDocumentId && !userConfig.writeDefaultDocumentId) {
        userConfig.queryDefaultDocumentId = userConfig.defaultDocumentId;
        userConfig.writeDefaultDocumentId = userConfig.defaultDocumentId;
      }

      const cfg = deepMerge(DEFAULT_CONFIG, userConfig);
      // 环境变量覆盖敏感信息
      if (process.env.WDT_SID) cfg.wangdian.sid = process.env.WDT_SID;
      if (process.env.WDT_KEY) cfg.wangdian.key = process.env.WDT_KEY;
      if (process.env.WDT_SECRET) cfg.wangdian.secret = process.env.WDT_SECRET;
      if (process.env.WDT_SALT) cfg.wangdian.salt = process.env.WDT_SALT;
      return cfg;
    }
  } catch (err) {
    console.error('[config] 加载配置失败:', err.message);
  }
  // 使用深拷贝避免修改 DEFAULT_CONFIG 的嵌套对象
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log('[config] 配置已保存');
}

function getDocumentById(config, docId) {
  return config.documents.find(d => d.id === docId) || null;
}

function getDefaultDocument(config) {
  if (config.queryDefaultDocumentId) {
    return getDocumentById(config, config.queryDefaultDocumentId);
  }
  return config.documents[0] || null;
}

function getWriteDefaultDocument(config) {
  if (config.writeDefaultDocumentId) {
    return getDocumentById(config, config.writeDefaultDocumentId);
  }
  return config.documents[0] || null;
}

function validateConfig(config) {
  const errors = [];
  // 检查已使用的提供商的凭据
  const usedProviders = new Set((config.documents || []).map(d => d.provider || 'tencent'));
  if (usedProviders.has('tencent') && !config.tencentDocs.apiKey) {
    errors.push('腾讯文档 API Key 未配置');
  }
  if (usedProviders.has('feishu') && !config.feishuDocs.appId) {
    errors.push('飞书 App ID 未配置');
  }
  if (usedProviders.has('jinshan') && !config.jinshanDocs.accessToken) {
    errors.push('金山文档 Access Token 未配置');
  }
  if (!config.documents || config.documents.length === 0) {
    errors.push('至少需要配置一个文档');
  } else {
    for (const doc of config.documents) {
      if (!doc.fileId) errors.push(`文档"${doc.name}"缺少 fileId`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { loadConfig, saveConfig, getDocumentById, getDefaultDocument, getWriteDefaultDocument, validateConfig, deepMerge, DEFAULT_CONFIG };
