/**
 * write-pipeline.js - 共享写入管线
 * 从 server.js 提取的 extract + execute 逻辑，供 automation 引擎复用
 * 不修改现有 server.js 路由（降低风险），此模块仅供 automation 调用
 */

const docProvider = require('./doc-provider');
const { extractRowData } = require('./extractor');
const { autoMatchWdtOrder, mergeWdtData } = require('./wangdian');
const { getDocumentById } = require('./config');
const { parseCsvLine } = require('./shared-docs');

const HEADER_SAMPLE_ROW_LIMIT = 50;
const EMPTY_ROW_BATCH_SIZE = 50;
const MAX_DESCRIPTION_LENGTH = 5000;

/**
 * 解析文档与写入目标
 */
function resolveTarget(config, docId, targetId) {
  const doc = getDocumentById(config, docId || config.writeDefaultDocumentId);
  if (!doc) return { success: false, error: '未找到指定文档' };
  const target = (doc.writeTargets || []).find(t => t.id === targetId);
  if (!target) return { success: false, error: '未找到指定的写入目标表格' };
  return { success: true, doc, target };
}

/**
 * 读取目标工作表表头和采样数据
 * 逻辑源自 server.js 第 471-500 行
 */
async function readSheetHeaders(config, doc, target) {
  try {
    const targetFileId = target.fileId || doc.fileId;
    const adapter = docProvider.getAdapter(doc);
    const providerConfig = docProvider.getProviderConfig(config, doc);
    const state = adapter.getDocState(targetFileId);
    if (adapter.init) await adapter.init(providerConfig, state);
    const sheets = await adapter.getSheetList(providerConfig, state, targetFileId);
    const sheet = sheets.find(s => s.sheet_name === target.sheetName) || sheets[0];
    if (!sheet) return { success: false, error: '文档中未找到任何工作表' };

    const csv = await adapter.readSheetCsv(
      providerConfig, state,
      targetFileId, sheet.sheet_id, Math.min(sheet.row_count, HEADER_SAMPLE_ROW_LIMIT), sheet.col_count
    );

    const allLines = csv.split('\n');
    const lines = allLines.filter(l => l.trim());
    if (lines.length === 0) return { success: false, error: '工作表为空' };

    const headers = parseCsvLine(lines[0]);
    while (headers.length > 0 && !headers[headers.length - 1].trim()) {
      headers.pop();
    }

    const parsedRows = allLines.map(line => parseCsvLine(line));

    return {
      success: true,
      headers,
      allLines,
      parsedRows,
      sheet,
      targetFileId,
      state,
      adapter,
      providerConfig
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 查重检测（独立函数，避免嵌套过深）
 * @param {Array} headers 表头数组
 * @param {Array} parsedRows 预解析的二维数组
 * @param {Object} extractResult extractRowData 的返回值
 * @param {Object} target 写入目标
 * @returns {{ isDuplicate: boolean, targetRow: number, duplicateInfo: object|null }}
 */
function detectDuplicate(headers, parsedRows, extractResult, target) {
  const logisticsColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name === '快递单号' || name === '物流单号';
  });

  if (logisticsColIdx < 0) {
    return { isDuplicate: false, targetRow: -1, duplicateInfo: null };
  }

  const newLogisticsNo = (extractResult.values[logisticsColIdx] || '').trim();
  if (!newLogisticsNo) {
    return { isDuplicate: false, targetRow: -1, duplicateInfo: null };
  }

  for (let i = 1; i < parsedRows.length; i++) {
    const rowCells = parsedRows[i];
    const existingNo = (rowCells[logisticsColIdx] || '').trim();
    if (existingNo === newLogisticsNo) {
      while (rowCells.length < headers.length) rowCells.push('');
      const existingValues = headers.map((_, idx) => rowCells[idx] || '');

      const emptyFieldIndices = [];
      for (let j = 0; j < headers.length; j++) {
        const headerName = (headers[j] || '').trim();
        const isRemark = headerName === '备注' || headerName === 'remark';
        const val = (existingValues[j] || '').trim();
        if (!val && !isRemark) emptyFieldIndices.push(j);
      }

      const isComplete = emptyFieldIndices.length === 0;

      let duplicateInfo;
      if (isComplete) {
        duplicateInfo = { type: 'overwrite', existingRow: i, existingValues: existingValues, newValues: extractResult.values.slice(), changedFields: [] };
        for (let j = 0; j < headers.length; j++) {
          const oldVal = (existingValues[j] || '').trim();
          const newVal = (extractResult.values[j] || '').trim();
          if (oldVal !== newVal) {
            duplicateInfo.changedFields.push({ col: j, header: headers[j], oldValue: existingValues[j] || '', newValue: extractResult.values[j] || '' });
          }
        }
      } else {
        const mergedValues = existingValues.slice();
        const filledFields = [];
        for (let j = 0; j < headers.length; j++) {
          const existingVal = (existingValues[j] || '').trim();
          const newVal = (extractResult.values[j] || '').trim();
          if (!existingVal && newVal) {
            mergedValues[j] = newVal;
            filledFields.push({ col: j, header: headers[j], oldValue: '', newValue: newVal });
          }
        }
        duplicateInfo = { type: 'merge', existingRow: i, existingValues: existingValues, newValues: extractResult.values.slice(), mergedValues: mergedValues, filledFields: filledFields, emptyFieldIndices: emptyFieldIndices };
      }
      return { isDuplicate: true, targetRow: i, duplicateInfo: duplicateInfo };
    }
  }

  return { isDuplicate: false, targetRow: -1, duplicateInfo: null };
}

/**
 * 从描述文本提取结构化数据（LLM + 规则 + 旺店通匹配 + 查重检测）
 * 逻辑源自 server.js 第 502-649 行
 * @param {Array} [parsedRows] 预解析的二维数组，避免重复解析全表 CSV
 */
async function extractAndPrepare(config, doc, target, description, headersInfo, parsedRows) {
  if (!description || !description.trim()) {
    return { success: false, error: '描述内容为空' };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { success: false, error: '描述内容过长' };
  }

  const { headers, allLines, sheet, targetFileId } = headersInfo;
  const rows = parsedRows || allLines.map(line => parseCsvLine(line));

  // 并行执行：LLM 提取 + 旺店通自动匹配
  const wdtCfg = config.wangdian || {};
  const wdtEnabled = wdtCfg.sid && wdtCfg.key && wdtCfg.secret && wdtCfg.salt;

  const [extractResult, wdtMatch] = await Promise.all([
    extractRowData(config.llm, headers, target.name, description),
    wdtEnabled ? autoMatchWdtOrder(wdtCfg, description) : Promise.resolve(null)
  ]);

  if (wdtMatch) {
    mergeWdtData(headers, extractResult, wdtMatch);
  }

  if (extractResult.nonEmptyCount === 0) {
    return { success: false, error: '未能从描述中提取到任何有效数据' };
  }

  // 查找第一个空行
  let emptyRowIndex = rows.length;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const isEmpty = cells.every(c => !c || !c.trim());
    if (isEmpty) {
      emptyRowIndex = i;
      break;
    }
  }

  // 查重检测
  const dupResult = detectDuplicate(headers, rows, extractResult, target);
  const duplicateInfo = dupResult.duplicateInfo;

  const finalTargetRow = duplicateInfo ? duplicateInfo.existingRow : emptyRowIndex;
  const finalValues = (duplicateInfo && duplicateInfo.type === 'merge')
    ? duplicateInfo.mergedValues
    : extractResult.values;

  return {
    success: true,
    headers,
    values: finalValues,
    newRowValues: finalValues,
    missing: extractResult.missing,
    targetRow: finalTargetRow,
    sheetId: sheet.sheet_id,
    targetFileId: targetFileId,
    duplicate: duplicateInfo,
    debug: {
      method: extractResult.method,
      nonEmptyCount: extractResult.nonEmptyCount,
      wdtMatch: wdtMatch ? { shop_name: wdtMatch.shop_name, logistics_no: wdtMatch.logistics_no } : null
    }
  };
}

/**
 * 查找下一个空行
 * 逻辑源自 server.js 第 41-62 行
 */
async function findNextEmptyRow(doc, config, state, fileId, sheetId, startRow, colCount, maxRowCount) {
  const adapterRow = await docProvider.findEmptyRow(doc, config, state, fileId, sheetId, startRow, colCount, maxRowCount);
  if (adapterRow !== null) return adapterRow;

  let currentRow = startRow;
  while (currentRow < maxRowCount) {
    const endRow = Math.min(currentRow + EMPTY_ROW_BATCH_SIZE, maxRowCount);
    const csv = await docProvider.readSheetCsv(doc, config, state, fileId, sheetId, endRow, colCount, currentRow);
    const allLines = csv.split('\n');
    const expectedRows = endRow - currentRow;
    for (let i = 0; i < Math.min(allLines.length, expectedRows); i++) {
      const cells = parseCsvLine(allLines[i]);
      if (cells.every(c => !c || !c.trim())) {
        return currentRow + i;
      }
    }
    currentRow += EMPTY_ROW_BATCH_SIZE;
  }
  return maxRowCount;
}

/**
 * 执行写入
 * 逻辑源自 server.js 第 685-710 行
 * @param {Object} [headersInfo] readSheetHeaders 的返回值，复用 adapter/state/providerConfig/sheet 避免重复调用
 */
async function executeWrite(config, doc, prepareResult, headersInfo) {
  try {
    const { targetFileId, sheetId, targetRow, values, duplicate } = prepareResult;
    const writeDocId = targetFileId || doc.fileId;

    const adapter = (headersInfo && headersInfo.adapter) || docProvider.getAdapter(doc);
    const providerConfig = (headersInfo && headersInfo.providerConfig) || docProvider.getProviderConfig(config, doc);
    const state = (headersInfo && headersInfo.state) || adapter.getDocState(writeDocId);

    let sheet = (headersInfo && headersInfo.sheet) || null;
    if (!sheet) {
      const sheets = await adapter.getSheetList(providerConfig, state, writeDocId);
      sheet = sheets.find(s => s.sheet_id === sheetId);
      if (!sheet) return { success: false, error: '未找到指定工作表' };
    }

    let actualRow;
    if (duplicate) {
      actualRow = targetRow;
    } else {
      actualRow = await findNextEmptyRow(doc, config, state, writeDocId, sheetId, targetRow, sheet.col_count, sheet.row_count);
    }

    const result = await adapter.writeRow(providerConfig, state, writeDocId, sheetId, actualRow, values);
    adapter.clearCache(writeDocId);

    return { success: true, row: actualRow, updateNum: result.updateNum, newRowValues: prepareResult.values };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { resolveTarget, readSheetHeaders, extractAndPrepare, findNextEmptyRow, executeWrite, detectDuplicate };
