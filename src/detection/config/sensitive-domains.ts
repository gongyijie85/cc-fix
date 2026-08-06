// 中国 AI 服务商敏感域名清单
// 来源：check-cc 项目逆向分析 + 社区贡献
// ANTHROPIC_BASE_URL 若命中以下域名，表示使用了国内 AI 代理/中转

export const SENSITIVE_DOMAINS: Set<string> = new Set([
  // 主要 AI 代理/中转平台
  "api.openai-proxy.com",
  "openai.api.com",
  "api.chatgpt.com",
  // 国内大模型平台
  "api.minimax.chat",
  "api.baichuan-ai.com",
  "open.bigmodel.cn",           // 智谱 GLM
  "chatglm.cn",
  "api.qianfan.baidu.com",      // 百度千帆
  "wenxin.baidu.com",
  "dashscope.aliyuncs.com",     // 阿里通义
  "tongyi.aliyun.com",
  "api.hunyuan.cloud.tencent.com", // 腾讯混元
  "hunyuan.tencent.com",
  "api.sensenova.cn",           // 商汤
  "platform.moonshot.cn",       // 月之暗面
  "api.moonshot.cn",
  "api.doubao.com",             // 字节豆包
  "www.doubao.com",
  "api.deepseek.com",           // DeepSeek
  "deepseek.com",
  "api.zhipuai.cn",             // 智谱
  "openai.azure.com",           // Azure OpenAI（中国区）
  // 常见代理域名
  "api.openai-proxy.org",
  "openai-proxy.com",
  "chatgpt-proxy.com",
  "claude-proxy.com",
  "anthropic-proxy.com",
  // 更多代理平台
  "api.w2w.qzz.io",
  "api.aigc369.com",
  "api.chatanywhere.org",
  "openai.api2d.net",
  "api.caipua.com",
  "api.xiamoai.top",
]);

export function isSensitiveDomain(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // 精确匹配
    if (SENSITIVE_DOMAINS.has(hostname)) return true;
    // 子域名匹配
    for (const domain of SENSITIVE_DOMAINS) {
      if (hostname.endsWith("." + domain)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
