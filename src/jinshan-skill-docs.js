/**
 * jinshan-skill-docs.js - 金山文档 Skill 适配器
 * 通过 kdocs-cli 命令行工具操作金山文档，仅需 Token 一个凭据
 * 大幅简化配置，替代原有 KSO-1 签名方式
 */

const { execFile } = require('child_process');
const { makeGetDocState, makeClearCache, MAX_COL_COUNT, csvRow, splitCsvLines, parseCsvLine } = require('./shared-docs');

// kdocs-cli 可执行文件路径
const KDOCS_CLI_PATH = process.env.KDOCS_CLI_PATH || 'kdocs-cli';

// 状态管理
const getDocState = makeGetDocState({ sheetsCache: null, sheetsCacheTime: 0 });
const clearCache = makeClearCache(getDocState, (state) => {
  state.sheetsCache = null;
  state.sheetsCacheTime = 0;
});

/**
 * 调用 kdocs-cli 工具
 */
function callCli(service, action, params, token) {
  return new Promise((resolve, reject) => {
    const args = [service, action, '--args', JSON.stringify(params), '--compact', '--token', token];
    const child = execFile(KDOCS_CLI_PATH, args, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env }
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr || err.message;
        reject(new Error(`kdocs-cli ${service} ${action} 失败: ${msg}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(`kdocs-cli 错误: ${result.error.message || result.error}`));
          return;
        }
        resolve(result);
      } catch (e) {
        reject(new Error(`kdocs-cli 响应解析失败: ${e.message}, stdout: ${stdout.substring(0, 200)}`));
      }
    });
  });
}

/**
 * 初始化（Skill 模式无需初始化，Token 已通过环境变量/配置传入）
 */
async function init(providerConfig, state) {
  // 无需初始化
}

/**
 * 获取工作表列表（带 5 分钟缓存）
 */
async function getSheetList(providerConfig, state, fileId) {
  // 缓存 5 分钟
  if (state.sheetsCache && state.sheetsCacheTime && (Date.now() - state.sheetsCacheTime) < 300000) {
    return state.sheetsCache;
  }

  const token = providerConfig.token;
  if (!token) throw new Error('金山文档 Token 未配置');

  const resp = await callCli('sheet', 'get-sheets-info', { file_id: fileId }, token);

  const sheetsInfo = resp.sheetsInfo || resp.detail?.sheetsInfo || [];
  const sheets = sheetsInfo.map(s => ({
    sheet_id: s.sheetId,
    sheet_name: s.sheetName,
    row_count: (s.rowTo || s.maxRow || 1000) + 1,
    col_count: (s.colTo || s.maxCol || 20) + 1,
    row_to: s.rowTo,
    col_to: s.colTo,
    is_empty: s.isEmpty
  }));

  state.sheetsCache = sheets;
  state.sheetsCacheTime = Date.now();
  return sheets;
}

/**
 * 读取工作表数据为 CSV 文本
 * 使用 sheet.get_range_data 读取区域数据，转换为 CSV
 */
async function readSheetCsv(providerConfig, state, fileId, sheetId, rowCount, colCount, startRow = 0) {
  const token = providerConfig.token;
  if (!token) throw new Error('金山文档 Token 未配置');

  // 先获取工作表信息以确定实际数据范围
  const sheets = await getSheetList(providerConfig, state, fileId);
  const sheet = sheets.find(s => s.sheet_id == sheetId || s.sheet_id === sheetId);
  if (!sheet) throw new Error(`未找到工作表: ${sheetId}`);

  // 使用实际数据范围，限制列数
  const actualRowTo = Math.min(sheet.row_to || rowCount - 1 || 999, rowCount - 1);
  const actualColTo = Math.min(sheet.col_to || colCount - 1 || MAX_COL_COUNT - 1, colCount - 1, MAX_COL_COUNT - 1);

  const params = {
    file_id: fileId,
    worksheet_id: typeof sheetId === 'number' ? sheetId : parseInt(sheetId, 10),
    range: {
      rowFrom: startRow,
      rowTo: actualRowTo,
      colFrom: 0,
      colTo: actualColTo
    }
  };

  const resp = await callCli('sheet', 'get-range-data', params, token);

  const rangeData = resp.rangeData || resp.detail?.rangeData || [];

  // 将 rangeData 转换为二维数组，再转为 CSV
  const grid = [];
  for (let r = startRow; r <= actualRowTo; r++) {
    grid.push(new Array(actualColTo + 1).fill(''));
  }

  for (const cell of rangeData) {
    const r = cell.rowFrom - startRow;
    const c = cell.colFrom;
    if (r >= 0 && r < grid.length && c >= 0 && c < (actualColTo + 1)) {
      grid[r][c] = cell.cellText || cell.originalCellValue || '';
    }
  }

  return grid.map(row => csvRow(row)).join('\n');
}

/**
 * 写入一行数据
 */
async function writeRow(providerConfig, state, fileId, sheetId, startRow, values) {
  const token = providerConfig.token;
  if (!token) throw new Error('金山文档 Token 未配置');

  const worksheetId = typeof sheetId === 'number' ? sheetId : parseInt(sheetId, 10);

  // 构建 rangeData：每个单元格一个 formula 操作
  const rangeData = values.map((val, colIdx) => ({
    opType: 'formula',
    rowFrom: startRow,
    rowTo: startRow,
    colFrom: colIdx,
    colTo: colIdx,
    formula: String(val || '')
  }));

  const params = {
    file_id: fileId,
    worksheet_id: worksheetId,
    rangeData: rangeData
  };

  const resp = await callCli('sheet', 'update-range-data', params, token);
  return { updateNum: rangeData.length, raw: resp };
}

/**
 * 查找下一个空行（内存扫描）
 * 一次读取全量数据后扫描空行
 */
async function findEmptyRow(providerConfig, state, fileId, sheetId, startRow, colCount, maxRowCount) {
  const csv = await readSheetCsv(providerConfig, state, fileId, sheetId, maxRowCount, colCount);
  const lines = splitCsvLines(csv);
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.every(c => !c || !c.trim())) {
      // 返回绝对行号（加上 startRow 偏移，因为 readSheetCsv 从 startRow 开始读）
      const absoluteRow = startRow + i;
      if (absoluteRow >= startRow) return absoluteRow;
    }
  }
  return lines.length + startRow;
}

module.exports = {
  init,
  getSheetList,
  readSheetCsv,
  writeRow,
  findEmptyRow,
  getDocState,
  clearCache,

  // 适配器元数据
  meta: {
    configKey: 'jinshanSkillDocs',
    label: '金山文档(Skill)',
    sensitiveFields: ['token'],
    requiredFields: ['token'],
    idLabel: 'File ID',
    idHint: '从金山文档URL中获取'
  }
};
