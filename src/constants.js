/**
 * 共享常量模块
 *
 * 本文件是 local 与 cloudflare-worker 之间共享常量的"单一数据源"。
 * CF Worker 为单文件部署，无法直接 require 本文件，
 * 因此 worker.js 中以同名常量块镜像维护，修改时需同步更新。
 *
 * 涉及的常量：
 * - PLATFORMS          电商平台列表（parseShopInfo 使用）
 * - FIELD_ALIASES      字段别名映射（ruleBasedExtract 使用）
 * - CLAIM_TYPES        理赔类型关键词（ruleBasedExtract 使用）
 * - TRADE_STATUS_MAP   旺店通订单状态映射
 * - WDT_FIELD_MAP      旺店通字段到表头的映射（合并旺店通数据时使用）
 * - LOGISTICS_NO_REGEX 物流单号提取正则
 */

// 电商平台列表（用于 parseShopInfo 解析店铺名称中的平台）
const PLATFORMS = [
  '京东', '淘宝', '天猫', '拼多多', '抖音', '快手',
  '小红书', '微信', '有赞', '微店', '苏宁', '唯品会',
  '当当', '1688', '阿里'
];

// 字段别名映射（用于 ruleBasedExtract 识别用户输入中的字段别名）
const FIELD_ALIASES = {
  '单号': '快递单号',
  '金额': '货值(元)',
  '价格': '货值(元)',
  '日期': '登记日期',
  '数量': '正品数量',
  '理赔': '理赔类型',
  '运费': '运费(元)',
  '货值': '货值(元)'
};

// 理赔类型关键词（用于 ruleBasedExtract 识别理赔类型）
// 按长度降序排列，确保最长匹配优先（如"就地销毁"优先于"销毁"）
const CLAIM_TYPES = [
  '就地销毁', '破损漏油', '地址错误', '无人收件',
  '丢件', '丢失', '破损', '少件', '少货', '漏发',
  '错发', '退件', '拒收', '超区', '销毁', '漏油',
  '空包裹', '空包'
];

// 旺店通订单状态映射
const TRADE_STATUS_MAP = {
  4: '线下退款',
  5: '已取消',
  6: '待审核',
  10: '未付款',
  55: '已审核',
  95: '已发货',
  110: '已完成'
};

// 旺店通字段到表头的映射（合并旺店通数据到提取结果时使用）
// key = 表头名称, value = 旺店通订单对象上的属性名
const WDT_FIELD_MAP = {
  '订单号': 'src_tids',
  '原始单号': 'src_tids',
  '快递单号': 'logistics_no',
  '物流单号': 'logistics_no',
  '店铺名称': 'parsedShopName',
  '店铺': 'parsedShopName',
  '平台': 'platform',
  '云仓': 'warehouse_name',
  '仓库': 'warehouse_name'
};

// 物流单号提取正则：纯字母数字、长度 >= 8、含数字
const LOGISTICS_NO_REGEX = /^[A-Za-z0-9]{8,}$/;

module.exports = {
  PLATFORMS,
  FIELD_ALIASES,
  CLAIM_TYPES,
  TRADE_STATUS_MAP,
  WDT_FIELD_MAP,
  LOGISTICS_NO_REGEX
};
