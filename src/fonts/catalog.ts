// 中文字体目录（ADR-0013）：检测与字体修复流的唯一事实源。

/** 中文字体文件名模式（不区分大小写）。 */
export const CHINESE_FONT_PATTERNS = [
  'msyh',       // Microsoft YaHei（微软雅黑）
  'simsun',     // 宋体
  'simhei',     // 黑体
  'simkai',     // 楷体
  'simfang',    // 仿宋
  'stsong',     // STSong
  'stzhongs',   // STZhongsong
  'stkaiti',    // STKaiti
  'mingliu',    // MingLiU（细明体）
  'pmingliu',   // PMingLiU
  'dengxian',   // 等线
  'fzht',       // 方正黑体
  'fzft',       // 方正仿宋
  'fzkaiti',    // 方正楷体
  'fzsongti',   // 方正宋体
  'hwxh',       // 华文行楷
  'stxihei',    // 华文细黑
  'yahei',      // YaHei 变体
] as const;

export function isChineseFontFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return CHINESE_FONT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** 特权助手白名单：仅接受字母数字点横线文件名的 ttf/ttc（大小写不敏感）。 */
export function isSafeFontFileName(name: string): boolean {
  return /^[\w.-]+\.(ttf|ttc)$/iu.test(name);
}