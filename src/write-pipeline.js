/**
 * write-pipeline.js - 共享写入管线
 * 从 server.js 提取的 extract + execute 逻辑，供 automation 引擎复用
 * 不修改现有 server.js 路由（降低风险），此模块仅供 automation 调用
 */

const docProvider = require('./doc-provider');
const { extractRowData } = require('./extractor');
const { autoMatchWdtOrder, mergeWdtData, queryOrder, queryWarehouse } = require('./wangdian');
const { getDocumentById } = require('./config');
const { parseCsvLine, RateLimitError } = require('./shared-docs');
const writeQueue = require('./write-queue');

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

  // 防御 null/undefined values
  const values = extractResult.values || [];
  const newLogisticsNo = (values[logisticsColIdx] || '').trim();
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

      // 比较新旧数据：找出有差异的字段
      const changedFields = [];
      const newFieldsFilled = [];  // 新数据有值但旧数据为空的字段
      let allIdentical = true;

      for (let j = 0; j < headers.length; j++) {
        const headerName = (headers[j] || '').trim();
        const isRemark = headerName === '备注' || headerName === 'remark';
        const oldVal = (existingValues[j] || '').trim();
        const newVal = (values[j] || '').trim();

        if (newVal && oldVal && oldVal !== newVal) {
          allIdentical = false;
          changedFields.push({ col: j, header: headers[j], oldValue: existingValues[j] || '', newValue: values[j] || '' });
        } else if (!oldVal && newVal && !isRemark) {
          // 新数据有值，旧数据为空 → 可以补全
          allIdentical = false;
          newFieldsFilled.push({ col: j, header: headers[j], oldValue: '', newValue: newVal });
        }
      }

      // 情况1: 完全一致（所有非空字段值相同）→ 放弃写入
      if (allIdentical) {
        return {
          isDuplicate: true,
          targetRow: i,
          duplicateInfo: { type: 'skip', existingRow: i, existingValues, newValues: values.slice() }
        };
      }

      // 情况2: 旧数据不完整，新数据能补全 → merge
      if (newFieldsFilled.length > 0) {
        const mergedValues = existingValues.slice();
        for (const f of newFieldsFilled) {
          mergedValues[f.col] = f.newValue;
        }
        return {
          isDuplicate: true,
          targetRow: i,
          duplicateInfo: { type: 'merge', existingRow: i, existingValues, newValues: values.slice(), mergedValues, filledFields: newFieldsFilled, emptyFieldIndices }
        };
      }

      // 情况3: 旧数据已完整，新数据有不同值 → 不覆盖（保护已有数据）
      if (isComplete) {
        return {
          isDuplicate: true,
          targetRow: i,
          duplicateInfo: { type: 'skip', existingRow: i, existingValues, newValues: values.slice(), changedFields }
        };
      }

      // 情况4: 旧数据不完整，新数据也没有新信息 → skip
      return {
        isDuplicate: true,
        targetRow: i,
        duplicateInfo: { type: 'skip', existingRow: i, existingValues, newValues: values.slice() }
      };
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
  if (!headersInfo || !headersInfo.success) {
    return { success: false, error: headersInfo ? headersInfo.error : '表头信息缺失' };
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

  // ========== 规则后处理：修正LLM提取的常见错误 ==========

  // 修正1: 快递单号为空或"未提供"，但订单号是纯数字长串(>=10位) → 可能是快递单号被误填
  const logisticsColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name === '快递单号' || name === '物流单号';
  });
  const orderColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name === '订单号' || name === '订单编号';
  });
  if (logisticsColIdx >= 0 && orderColIdx >= 0) {
    const logisticsVal = (extractResult.values[logisticsColIdx] || '').trim();
    const orderVal = (extractResult.values[orderColIdx] || '').trim();
    const logisticsEmpty = !logisticsVal || logisticsVal === '未提供' || logisticsVal === '无';
    // 订单号是纯数字且>=10位（邮政新单号13位、其他快递单号通常也>=10位）
    const orderLooksLikeLogistics = /^\d{10,}$/.test(orderVal) || /^[A-Za-z]{2,4}\d{8,}$/.test(orderVal);
    if (logisticsEmpty && orderLooksLikeLogistics) {
      console.log(`[pipeline] 规则修正: 订单号"${orderVal}"疑似快递单号，移至快递单号字段`);
      extractResult.values[logisticsColIdx] = orderVal;
      extractResult.values[orderColIdx] = '';
      // 重新计算 nonEmptyCount
      extractResult.nonEmptyCount = extractResult.values.filter(v => v && v.trim()).length;
    }
  }

  // 修正2: 快递单号含中文前缀（如"快递单号SF123"）→ 清理
  if (logisticsColIdx >= 0) {
    const val = (extractResult.values[logisticsColIdx] || '').trim();
    if (val && /[\u4e00-\u9fa5]/.test(val)) {
      // 尝试提取纯字母数字部分
      const cleaned = val.match(/[A-Za-z0-9]{8,}/);
      if (cleaned) {
        console.log(`[pipeline] 规则修正: 快递单号"${val}"清理为"${cleaned[0]}"`);
        extractResult.values[logisticsColIdx] = cleaned[0];
      }
    }
  }

  // ERP优先：如果autoMatchWdtOrder未命中，用LLM提取的快递单号查ERP
  let finalWdtMatch = wdtMatch;
  if (!finalWdtMatch && wdtEnabled) {
    if (logisticsColIdx >= 0) {
      const extractedNo = (extractResult.values[logisticsColIdx] || '').trim();
      if (extractedNo && /\d/.test(extractedNo) && extractedNo !== '未提供') {
        try {
          const wdtResult = await queryOrder(wdtCfg, extractedNo);
          if (wdtResult.success && wdtResult.orders && wdtResult.orders.length > 0) {
            finalWdtMatch = wdtResult.orders[0];
            if (finalWdtMatch.warehouse_no) {
              finalWdtMatch.warehouse_name = await queryWarehouse(wdtCfg, finalWdtMatch.warehouse_no);
            }
            console.log(`[pipeline] LLM提取的物流单号 ${extractedNo} ERP匹配成功`);
          }
        } catch (e) {
          console.log(`[pipeline] LLM提取的物流单号 ${extractedNo} ERP未匹配: ${e.message}`);
        }
      }
    }
    // ERP fallback: 快递单号没查到，尝试用订单号查
    if (!finalWdtMatch && orderColIdx >= 0) {
      const orderNo = (extractResult.values[orderColIdx] || '').trim();
      if (orderNo && /^\d{8,}$/.test(orderNo)) {
        try {
          const wdtResult = await queryOrder(wdtCfg, orderNo);
          if (wdtResult.success && wdtResult.orders && wdtResult.orders.length > 0) {
            finalWdtMatch = wdtResult.orders[0];
            if (finalWdtMatch.warehouse_no) {
              finalWdtMatch.warehouse_name = await queryWarehouse(wdtCfg, finalWdtMatch.warehouse_no);
            }
            console.log(`[pipeline] 订单号 ${orderNo} ERP匹配成功(fallback)`);
          }
        } catch (e) {
          console.log(`[pipeline] 订单号 ${orderNo} ERP未匹配(fallback): ${e.message}`);
        }
      }
    }
  }

  if (finalWdtMatch) {
    mergeWdtData(headers, extractResult, finalWdtMatch);
  }

  if (extractResult.nonEmptyCount === 0) {
    return { success: false, error: '未能从描述中提取到任何有效数据' };
  }

  // ========== 质量检查 ==========
  const qualityIssues = [];

  // 检查1: ERP是否匹配
  const wdtMatched = !!finalWdtMatch;
  if (!wdtMatched && wdtEnabled) {
    qualityIssues.push('erp_not_matched');
  }

  // 检查2: 是否有有效金额（货值 > 0）
  const amountColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name.includes('货值') || name.includes('金额') || name.includes('价格');
  });
  if (amountColIdx >= 0) {
    const amount = (extractResult.values[amountColIdx] || '').trim();
    const numAmount = parseFloat(amount);
    if (!amount || !/^\d+\.?\d*$/.test(amount) || numAmount <= 0) {
      qualityIssues.push('no_amount');
    }
  }

  // 检查3: 是否有物流单号（复用已定义的 logisticsColIdx）
  if (logisticsColIdx >= 0) {
    const logisticsNo = (extractResult.values[logisticsColIdx] || '').trim();
    if (!logisticsNo) {
      qualityIssues.push('no_logistics_no');
    }
  }

  // 检查4: 店铺名称是否误填了状态描述
  const shopColIdx = headers.findIndex(h => {
    const name = (h || '').trim();
    return name === '店铺名称' || name === '店铺' || name === '商家';
  });
  if (shopColIdx >= 0) {
    const shopVal = (extractResult.values[shopColIdx] || '').trim();
    const statusKeywords = ['已退', '已退款', '已签收', '已发货', '已揽收', '平台已退', '退回', '异常'];
    for (const kw of statusKeywords) {
      if (shopVal === kw || shopVal.includes(kw)) {
        qualityIssues.push('shop_name_invalid');
        break;
      }
    }
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

  // 如果查重结果为skip，直接返回跳过标记（不执行写入）
  if (duplicateInfo && duplicateInfo.type === 'skip') {
    return {
      success: true,
      skipped: true,
      skipReason: duplicateInfo.changedFields && duplicateInfo.changedFields.length > 0
        ? 'existing_data_complete'
        : 'identical',
      headers,
      values: extractResult.values,
      newRowValues: extractResult.values,
      missing: extractResult.missing,
      targetRow: duplicateInfo.existingRow,
      sheetId: sheet.sheet_id,
      targetFileId: targetFileId,
      duplicate: duplicateInfo,
      debug: {
        method: extractResult.method,
        nonEmptyCount: extractResult.nonEmptyCount,
        wdtMatch: finalWdtMatch ? { shop_name: finalWdtMatch.shop_name, logistics_no: finalWdtMatch.logistics_no } : null
      },
      qualityIssues,
      wdtMatched
    };
  }

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
      wdtMatch: finalWdtMatch ? { shop_name: finalWdtMatch.shop_name, logistics_no: finalWdtMatch.logistics_no } : null
    },
    qualityIssues,
    wdtMatched
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
 * 查找追加位置：最后一个非空行的下一行
 * 用于批量写入时确保不会覆盖间隙后的已有数据
 */
async function findAppendPosition(doc, config, state, fileId, sheetId, colCount, maxRowCount) {
  let lastNonEmpty = 0; // 0 = header row
  let currentRow = 1;
  while (currentRow < maxRowCount) {
    const endRow = Math.min(currentRow + EMPTY_ROW_BATCH_SIZE, maxRowCount);
    const csv = await docProvider.readSheetCsv(doc, config, state, fileId, sheetId, endRow, colCount, currentRow);
    const lines = csv.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      if (cells.some(c => c && c.trim())) {
        lastNonEmpty = currentRow + i;
      }
    }
    currentRow += EMPTY_ROW_BATCH_SIZE;
  }
  return lastNonEmpty + 1;
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
    // 限流检测：通过 isRateLimit 属性检测（跨模块更稳健，不依赖 instanceof）
    if (err && err.isRateLimit) {
      writeQueue.setRateLimited();
      return { success: false, rateLimited: true, error: err.message };
    }
    return { success: false, error: err.message };
  }
}

/**
 * 批量写入多条记录
 * 新记录写入连续空行（优先使用适配器 writeRows 单次 API 调用）；
 * 查重 merge 记录逐条写入到各自指定的目标行。
 * @param {Object} config 配置
 * @param {Object} doc 文档配置
 * @param {Array<{ message: object, prepareResult: object }>} records 待写记录
 * @param {Object} headersInfo readSheetHeaders 返回值（复用 adapter/state/sheet）
 * @returns {{ success: boolean, rateLimited?: boolean, error?: string, written?: number, results?: Array }}
 */
async function executeBatchWrite(config, doc, records, headersInfo) {
  // results 在 try 外声明，以便 catch 中返回已成功写入的部分结果
  const results = [];
  try {
    if (!records || records.length === 0) {
      return { success: true, written: 0, results: [] };
    }

    const firstPrepare = records[0].prepareResult;
    const { targetFileId, sheetId } = firstPrepare;
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

    // 分离：新记录（连续空行批量写入）和 merge 记录（逐条写入到指定行）
    const newRecords = [];
    const mergeRecords = [];
    for (const rec of records) {
      const dup = rec.prepareResult.duplicate;
      if (dup && dup.type === 'merge') {
        mergeRecords.push(rec);
      } else {
        newRecords.push(rec);
      }
    }

    // 批量写入新记录到连续空行
    if (newRecords.length > 0) {
      // 多条记录时使用 findAppendPosition 避免覆盖间隙后的已有数据
      // 单条记录时仍用 findNextEmptyRow（性能更好，找到第一个空行即可）
      const startRow = newRecords.length > 1
        ? await findAppendPosition(doc, config, state, writeDocId, sheetId, sheet.col_count, sheet.row_count)
        : await findNextEmptyRow(
            doc, config, state, writeDocId, sheetId,
            newRecords[0].prepareResult.targetRow,
            sheet.col_count, sheet.row_count
          );
      const rowsValues = newRecords.map(r => r.prepareResult.values);

      if (adapter.writeRows && newRecords.length > 1) {
        // 单次 API 调用写入多行（set_range_value 原子操作）
        await adapter.writeRows(providerConfig, state, writeDocId, sheetId, startRow, rowsValues);
      } else {
        // 回退：逐条写入连续行（适配器不支持批量或只有单条）
        for (let i = 0; i < newRecords.length; i++) {
          await adapter.writeRow(providerConfig, state, writeDocId, sheetId, startRow + i, rowsValues[i]);
        }
      }

      for (let i = 0; i < newRecords.length; i++) {
        results.push({
          messageId: newRecords[i].message.id,
          row: startRow + i,
          success: true,
          newRowValues: newRecords[i].prepareResult.values
        });
      }
    }

    // 逐条写入 merge 记录到各自的目标行
    for (const rec of mergeRecords) {
      const pr = rec.prepareResult;
      const actualRow = pr.targetRow;
      await adapter.writeRow(providerConfig, state, writeDocId, sheetId, actualRow, pr.values);
      results.push({
        messageId: rec.message.id,
        row: actualRow,
        success: true,
        newRowValues: pr.values
      });
    }

    if (results.length > 0) {
      adapter.clearCache(writeDocId);
    }

    return { success: true, written: results.length, results };
  } catch (err) {
    // 限流：捕获 RateLimitError，设置限流状态
    if (err && (err.isRateLimit || err instanceof RateLimitError)) {
      writeQueue.setRateLimited();
      return { success: false, rateLimited: true, error: err.message, results };
    }
    // 其他错误：返回已成功写入的部分结果，调用方据此决定哪些需要重新入队
    return { success: false, error: err.message, results };
  }
}

module.exports = { resolveTarget, readSheetHeaders, extractAndPrepare, findNextEmptyRow, findAppendPosition, executeWrite, executeBatchWrite, detectDuplicate };
