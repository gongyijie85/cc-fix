// 兼容转发（#99）：地区目录唯一事实源已下沉 domain/region-catalog；
// 本文件保留原导入路径以免历史调用面（GUI/CLI）扩散。
export { DEFAULT_REGION, getTargetRegion, TARGET_REGIONS } from "../domain/region-catalog.js";
