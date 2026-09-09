# 服务端部署与加固说明

这份文档讲清楚两件事：怎么把一个内网智能体开放到公网，以及开放之前必须做哪些加固。

如果你只想改前端页面，不需要看这里，直接读仓库根目录的 README。

## 先想清楚风险

实验室里的智能体为了方便，通常开着 Shell 命令、文件读写和代码执行。这些能力在内网是效率工具，一旦挂到公网上就成了漏洞。陌生人不需要破解任何东西，只需要在对话框里说一句「执行 rm -rf /data」就够你受的。

所以本仓库的设计前提只有一条：**公网那一侧永远不接触带写权限的实例**。具体做法是另起一个只读实例，而不是给现网实例加密码。

## 第一步：准备只读实例

你需要一个只开放了安全工具的智能体实例。如果你的后端是 Qwen-Agent，可以直接裁剪工具列表：

```python
tools = ['web_search', 'open_url', 'get_current_time']   # 只留联网与查询时间
Assistant(llm=cfg, function_list=tools)
```

同时确认三件事：实例监听 `127.0.0.1` 而不是 `0.0.0.0`；数据目录与原实例分离；系统提示词里没有个人标识和目录路径。

本项目实际部署时用一个脚本对现网 `agent_server.py` 做文本改写来生成这个实例，改写点包括清空 `ALLOWED_ROOTS`、把工具开关全部置为关闭（仅保留联网）、删除管理类路由、去掉 Gradio 界面与定时任务调度器。这条链路与你的后端强相关，所以没有放进仓库，按上面的原则自行实现即可。

## 第二步：挂上网关

```bash
python3 public_gateway.py \
    --upstream http://127.0.0.1:8800 \
    --host 127.0.0.1 --port 8801 \
    --per-minute 6 --per-hour 40 \
    --max-concurrent 3 --max-tokens 1024 \
    --audit-log ./logs/audit.jsonl
```

网关是纯标准库实现，没有第三方依赖。它做四件事。

**路由白名单。** 公网只放行 `GET /api/health` 与 `POST /api/chat`，其余路径一律 404。这一层是最后一道保险，即使上游实例将来被改动，管理接口也碰不到。

**限流与并发。** 按来源 IP 做每分钟与每小时双窗口计数，同时用信号量限制后端并发。走 ngrok 时真实 IP 从 `X-Forwarded-For` 的最左侧取值，否则所有流量都会被算成 `127.0.0.1` 而让限流失效。

**请求体检。** 限制请求体 256 KB、消息 20 条、单条 4000 字，并把 `max_tokens` 强制压到配置上限以内。上下文只有 8K 的模型很容易被超长输入撑爆，这一步不能省。客户端传入的 `model` 与 `mode` 字段会被丢弃，避免访客自定义模型或触发自主执行模式。

**SSE 透传。** 上游是 `text/event-stream` 时逐块转发，不做任何缓冲，前端的逐字显示效果才有保障。

## 第三步：穿透出去

ngrok 最省事，一条命令就有 HTTPS 域名：

```bash
ngrok http 8801
```

免费版有几个坑。低于 3.20 的 agent 会被服务端直接拒收，报错 `ERR_NGROK_121`，升级到最新版即可。免费版还会给浏览器请求插一张「Visit Site」拦截页，前端必须带上 `ngrok-skip-browser-warning: true` 才能绕过；一旦带了这个自定义头，浏览器就会先发 OPTIONS 预检，网关回显 `Access-Control-Request-Headers` 正是为了让它通过。另外免费版的地址每次重启都会变，想固定就在控制台申请一个免费静态域名，然后：

```bash
ngrok http --domain=your-name.ngrok-free.app 8801
```

frp 和 Cloudflare Tunnel 同样可用。frp 需要一台有公网 IP 的服务器；Cloudflare Tunnel 免费且没有拦截页，named tunnel 需要你有一个域名。

## 第四步：接上前端

把拿到的 HTTPS 地址填进 `docs/assets/config.js` 的 `endpoint`，推送后 GitHub Pages 自动生效：

```js
endpoint: "https://your-name.ngrok-free.app",
```

## 运维

```bash
bash start_public.sh          # 启动全部组件
bash start_public.sh status   # 查看状态与当前公网地址
bash start_public.sh stop     # 停止全部
bash start_public.sh restart  # 重启（注意：会更换 ngrok 随机域名）
```

日志在 `logs/` 下，`audit.jsonl` 逐条记录每次对话的来源 IP、输入长度与 User-Agent。

配合 systemd 或 supervisor 做开机自启会更省心。要注意的是服务器重启后 ngrok 会换地址，所以更稳妥的做法是申请静态域名，或者写个小脚本把新地址自动同步到仓库。

## 上线前自查

- [ ] 公网实例的工具列表里没有 Shell、代码执行、文件写入
- [ ] 实例只监听 `127.0.0.1`
- [ ] 从外网访问 `/api/agent-config`、`/api/automation` 等管理接口返回 404
- [ ] 让模型执行 `whoami` 或读取 `/etc/passwd`，确认它拒绝且无对应工具
- [ ] 限流生效：连续快速请求会收到 429
- [ ] 审计日志正常写入
- [ ] 系统提示词里没有个人标识与真实目录路径
