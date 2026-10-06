/**
 * 演示站配置。
 *
 * 这里的 endpoint 指向一个公开可访问的智能体服务地址。
 * 仓库所有者部署后把 <ENDPOINT> 换成自己的域名即可；
 * 访客也可以在页面上「设置」里临时填自己的地址（存 localStorage，只影响本机）。
 */
window.DEMO_CONFIG = {
  // 智能体服务地址（不要带结尾斜杠）。
  // 这是 ngrok 隧道地址。免费版每次重启都会生成新地址（已实测验证），
  // 所以换了地址必须同步改这里并重新推送 Pages。
  // 想要固定地址有两种办法：
  //   1) ngrok Hobbyist($10/月)：控制台 Domains 里挑一个自定义域名，
  //      再用 `NGROK_DOMAIN=你的域名.ngrok.app bash server/start_public.sh` 启动；
  //   2) Cloudflare Tunnel(免费，需自备一个域名)：在服务器跑 cloudflared。
  endpoint: "https://b6a1-2001-250-3c0f-1006-00-cfa7.ngrok-free.app",

  // 展示用的元信息，只影响界面文案
  site: {
    title: "Qwen3-VL 智能体 · 在线体验",
    subtitle: "Qwen3-VL 多模态智能体 · 支持图文输入、工具调用与流式输出",
    botName: "Qwen-Agent",
    repo: "https://github.com/LHHugh/LocalAgent",
    author: "LHHugh",
  },

  // 默认生成参数
  defaults: {
    temperature: 0.7,
    maxTokens: 1024,
    // 单条消息的最大字符数（同时也是服务端限流的参考值）
    maxInputChars: 4000,
  },

  // 首页示例问题
  suggestions: [
    "用一句话解释什么是视频时序定位（Video Temporal Grounding）",
    "帮我查一下今天 AI 领域有什么值得关注的新闻",
    "写一个 Python 函数，把嵌套字典按路径展开成扁平字典",
    "对比一下 Mamba 和 Transformer 在长序列建模上的差异",
  ],

  // 免责声明，显示在页脚
  disclaimer:
    "本站为个人研究性质的公开演示，模型在单台实验室服务器上运行，可能因维护、关机或网络波动而不可用。请勿输入任何敏感信息。",
};
