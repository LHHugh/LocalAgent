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

**请求体检。** 当前代码限制请求体为 12 MiB，保留最后 20 条消息；纯文本消息或多模态消息中的每个文本分段最多保留 16000 字符。图片仅接受内联 `data:image/` URL，单个 URL 长度上限为 `9 * 1024 * 1024` 字符，不接受外链图片。`max_tokens` 会被压到启动参数配置的上限以内（默认 1024）。模型总上下文取决于推理服务配置。客户端传入的 `model` 与 `mode` 字段会被丢弃。

**SSE 透传。** 上游是 `text/event-stream` 时逐块转发，不做任何缓冲，前端的逐字显示效果才有保障。

## 第三步：穿透出去

ngrok 最省事，一条命令就有 HTTPS 域名：

```bash
ngrok http 8801
```

如果浏览器请求遇到 ngrok 的「Visit Site」提示页，前端会通过 `ngrok-skip-browser-warning: true` 请求头处理。这个头会触发 OPTIONS 预检，网关回显 `Access-Control-Request-Headers` 以支持它。域名是否变化取决于账号与隧道配置；如已分配固定域名，可按当前 ngrok 客户端支持的参数启动，例如：

```bash
ngrok http --domain=your-name.ngrok-free.app 8801
```

frp、Cloudflare Tunnel 或 HTTPS 反向代理也可用于提供公网入口；请按所选服务的当前文档配置域名与 TLS。

## 第四步：接上前端

把拿到的 HTTPS 地址填进 `docs/assets/config.js` 的 `endpoint`，推送后 GitHub Pages 自动生效：

```js
endpoint: "https://your-name.ngrok-free.app",
```

## 运维

`start_public.sh` 是原部署环境的模板。使用前先修改其中的 `PY`、`ROOT` 与 ngrok 路径，并准备自己的 `public_agent_server.py`（本仓库不包含该智能体服务实现）。

```bash
bash start_public.sh          # 启动全部组件
bash start_public.sh status   # 查看状态与当前公网地址
bash start_public.sh stop     # 停止全部
bash start_public.sh restart  # 重启；随后检查公网地址是否变化
```

日志在 `logs/` 下，`audit.jsonl` 逐条记录每次对话的来源 IP、输入长度与 User-Agent。

配合 systemd 或 supervisor 可以配置开机自启。如果隧道地址发生变化，需要同步更新前端配置。根目录的 `sync_ngrok.py` 提供同步辅助，首次使用建议先执行 `--dry-run`；默认运行会尝试提交并推送修改。

## 上线前自查

- [ ] 公网实例的工具列表里没有 Shell、代码执行、文件写入
- [ ] 实例只监听 `127.0.0.1`
- [ ] 从外网访问 `/api/agent-config`、`/api/automation` 等管理接口返回 404
- [ ] 让模型执行 `whoami` 或读取 `/etc/passwd`，确认它拒绝且无对应工具
- [ ] 限流生效：连续快速请求会收到 429
- [ ] 审计日志正常写入
- [ ] 系统提示词里没有个人标识与真实目录路径
