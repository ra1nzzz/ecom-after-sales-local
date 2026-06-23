# 综合电商售后处理系统 v2

可配置、可复用、可读、可写的综合电商售后处理系统。

## 功能

### 查询（读）
- 支持配置多个腾讯文档，下拉切换查询
- 按快递单号搜索退货记录
- 数据自动缓存与定时刷新

### 写入（写）
- 选择目标表格（如：快递理赔登记表、售后换货登记表）
- 用自然语言描述要写入的内容
- LLM 自动识别表头结构并提取数据
- 写入前检查目标行是否为空（防止并发冲突）
- 缺失字段提示用户补充

### 设置
- 配置多个文档地址（File ID、读取关键词、写入目标）
- 配置腾讯文档 API Key
- 配置 LLM（支持 DeepSeek/豆包/通义千问/Ollama 本地/OpenAI）
- 设置默认文档
- 缓存参数配置

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

复制 `config.example.json` 为 `config.json`，填入：
- 腾讯文档 API Key
- 文档 File ID
- LLM API Key 和 Base URL

或启动后访问"设置"页面在线配置。

### 3. 启动

```bash
npm start
```

或双击 `manage.bat` 使用管理工具。

### 4. 访问

- 本机: http://localhost:3000
- 局域网: http://<本机IP>:3000

## LLM 配置说明

| 服务商 | Base URL | 模型示例 |
|--------|----------|---------|
| DeepSeek | https://api.deepseek.com | deepseek-chat |
| 豆包(火山引擎) | https://ark.cn-beijing.volces.com/api/v3 | doubao-1-5-pro-32k |
| 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus |
| Ollama(本地) | http://localhost:11434/v1 | qwen2.5:7b |
| OpenAI | https://api.openai.com/v1 | gpt-4o-mini |

## 项目结构

```
├── server.js              # HTTP 服务器入口
├── config.json            # 用户配置（gitignore）
├── config.example.json    # 配置示例
├── package.json           # 依赖声明
├── src/
│   ├── config.js          # 配置加载/保存
│   ├── tencent-docs.js    # 腾讯文档 MCP 客户端（读+写）
│   ├── llm.js             # LLM 客户端（OpenAI 兼容）
│   └── extractor.js       # 自然语言→结构化数据提取
├── public/
│   └── index.html         # SPA 前端（查询/写入/设置）
├── manage.bat             # Windows 服务管理脚本
└── start-silent.vbs       # 无窗口启动脚本
```

## 技术栈

- Node.js (内置 http 模块，无框架依赖)
- OpenAI SDK (LLM 调用，兼容多厂商)
- Zod (数据校验)
- 腾讯文档 MCP API
- 原生 HTML/CSS/JS 前端
