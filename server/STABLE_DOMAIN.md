# 固定公网地址（不再每次重启换 URL）

ngrok 免费版**实测每次重启都会生成新地址**（已验证：`906d-…` → 重启后 `5a00-…`）。
免费版也**不能再保留或自定义域名**（agent 报 `ERR_NGROK_313: Only paid plans may
create endpoints with custom subdomains`）。所以"去控制台申请免费静态域名"这条路在
当前 ngrok 政策下已经不存在了。要固定地址，二选一：

## 方案 A：ngrok Hobbyist（$10/月，最简单）

1. 登录 https://dashboard.ngrok.com/billing/choose-a-plan ，选 **Hobbyist**
   （含 $10/月用量额度，基本等于免费）。
2. 左侧 **Domains → Create Domain**，挑一个名字（如 `qwen-demo`），后缀选
   `.ngrok.app`，得到 `qwen-demo.ngrok.app`。
3. 在服务器上重启链路，把域名传给脚本（脚本已用 `--url=` 参数）：

   ```bash
   NGROK_DOMAIN=qwen-demo.ngrok.app \
     bash /data1/lihenghao/qwen-agent-public/start_public.sh restart
   ```

   启动后公网地址固定为 `https://qwen-demo.ngrok.app`，不再变化。
4. 把 `docs/assets/config.js` 里的 `endpoint` 改成 `https://qwen-demo.ngrok.app`，
   提交并推送到 GitHub Pages。
5. 以后服务器/ngrok 重启，地址都不变，不用再改 `config.js`。

   额外好处：Hobbyist 去掉了免费版的 "Visit Site" 拦截页（当前前端用
   `ngrok-skip-browser-warning` 头绕过，付费后连这个都不需要）。

## 方案 B：Cloudflare Tunnel（免费，但需自备一个域名）

1. 准备一个你自己的域名（如 `example.com`，可在 Namesilo/Cloudflare 等花约 $10/年
   购买，或用已有域名下的子域）。
2. 在 https://dash.cloudflare.com 添加站点，按提示把域名的 NS 改成 Cloudflare 的
   （免费）。
3. 在服务器上安装 `cloudflared`。**注意**：这台服务器访问 `github.com` 不通，所以
   不能从 GitHub Releases 下载；要用 Cloudflare 官方镜像源，或让我帮忙确认可用的
   下载地址。
4. `cloudflared tunnel login` → 浏览器里选你的域名授权。
5. 建隧道并绑 DNS：

   ```bash
   cloudflared tunnel create qwen-demo
   cloudflared tunnel route dns qwen-demo demo.example.com
   ```

   得到永久地址 `https://demo.example.com`。
6. 常驻运行（建议配 systemd，避免掉线）：

   ```bash
   cloudflared tunnel --url http://localhost:8801 run qwen-demo
   ```

7. 把 `docs/assets/config.js` 的 `endpoint` 改成 `https://demo.example.com`，提交推送。

   好处：完全免费、地址永久、自带正式证书、无拦截页。前提是你得有一个域名，且服务器
   能装 `cloudflared`。

## 不固定的现状（当前）

当前用 ngrok 免费版，地址每次重启都变。换地址后必须改 `docs/assets/config.js` 的
`endpoint` 并重新推送 Pages，否则线上演示页会离线。若不想付钱也不想买域名，就维持
现状、重启后手动同步一次即可。
