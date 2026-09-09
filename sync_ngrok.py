#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ngrok 公网地址变更后，一键把新地址同步到 GitHub Pages 演示页。

场景：免费版 ngrok 每次重启/服务器重启都会换一个随机域名，导致
docs/assets/config.js 里的 endpoint 失效、演示页打不开。这个脚本做三件事：
  1. SSH 到部署服务器，从 ngrok 本地 API 读取当前的公网地址；
  2. 改写本地 docs/assets/config.js 的 endpoint（默认不重启 ngrok，只读同步）；
  3. git add / commit / push（push 失败会提示你手动推）。

安全：不硬编码任何密码 / token。SSH 密码从环境变量 NGROK_SSH_PASS、
本地未跟踪的 .ngrok_sync.env、或 --pass 参数获取；绝不要写进仓库。

用法：
  # 仅读取当前地址并同步 config.js（不重启、尝试推送）
  python sync_ngrok.py

  # 隧道挂了，先重启 systemd 服务再同步
  python sync_ngrok.py --restart

  # 只看看会改什么，不写文件、不推送
  python sync_ngrok.py --dry-run

  # 本地改完但不推（比如当前环境推不了 GitHub）
  python sync_ngrok.py --no-push

依赖：pip install paramiko
"""
import os
import re
import sys
import subprocess
import argparse

try:
    import paramiko
except ImportError:
    sys.exit("缺少依赖 paramiko：pip install paramiko")

# ---- 默认连接参数（不含密码） ----
DEFAULT_HOST = "10.249.43.22"
DEFAULT_USER = "boot"
DEFAULT_SSH_PORT = 22

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(SCRIPT_DIR, "docs", "assets", "config.js")
SYSTEMD_SVC = "qwen-ngrok"
XDG = "/run/user/1000"

URL_RE = re.compile(r'https://[A-Za-z0-9][A-Za-z0-9.\-]*\.ngrok[A-Za-z0-9.\-]*')


def load_env_file(path):
    """读取本地未跟踪的 .ngrok_sync.env（key=value，忽略 # 注释）。"""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def ssh_run(host, port, user, password, cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=user, password=password,
                   timeout=timeout, look_for_keys=False, allow_agent=False)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    client.close()
    return out, err


def get_public_url(host, port, user, password):
    cmd = "curl -s --max-time 5 http://127.0.0.1:4040/api/tunnels"
    out, err = ssh_run(host, port, user, password, cmd)
    urls = sorted(set(URL_RE.findall(out)))
    # 优先返回 https 的公网地址
    for u in urls:
        if u.startswith("https://"):
            return u
    return urls[0] if urls else ""


def restart_tunnel(host, port, user, password):
    cmd = (f"export XDG_RUNTIME_DIR={XDG}; "
           f"systemctl --user restart {SYSTEMD_SVC}; "
           "sleep 8; "
           "systemctl --user is-active " + SYSTEMD_SVC)
    out, err = ssh_run(host, port, user, password, cmd, timeout=40)
    return out.strip()


def patch_config(config_path, new_url):
    with open(config_path, "r", encoding="utf-8") as f:
        text = f.read()
    pat = re.compile(r'(endpoint:\s*")([^"]*)(")')
    m = pat.search(text)
    if not m:
        raise RuntimeError("在 config.js 里没找到 endpoint 行，无法替换")
    old = m.group(2)
    new_text = pat.sub(lambda x: x.group(1) + new_url + x.group(3), text, count=1)
    return old, new_text


def git_commit_push(repo_root, rel_path, url, no_push):
    if no_push:
        return "（--no-push）跳过 git 提交与推送"
    try:
        subprocess.run(["git", "-C", repo_root, "add", rel_path], check=True,
                       capture_output=True)
        msg = f"chore: 同步 ngrok 公网地址 {url}"
        r = subprocess.run(["git", "-C", repo_root, "commit", "-q", "-m", msg],
                           capture_output=True, text=True)
        if r.returncode != 0:
            return f"git commit 失败：{r.stderr.strip() or r.stdout.strip() or '（可能无变化）'}"
        p = subprocess.run(["git", "-C", repo_root, "push", "origin", "HEAD"],
                          capture_output=True, text=True, timeout=150)
        if p.returncode != 0:
            return (f"git commit 成功，但 push 失败（通常是因为本环境连不上 GitHub 的推送端点）。\n"
                    f"请在你自己的终端手动执行：git push\n错误：{p.stderr.strip()[:300]}")
        return "git commit + push 成功"
    except subprocess.TimeoutExpired:
        return "git push 超时（本环境到 GitHub 的推送端点不通）。请手动 git push。"
    except Exception as e:  # noqa
        return f"git 操作异常：{e}"


def main():
    ap = argparse.ArgumentParser(description="同步 ngrok 公网地址到演示页 config.js")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_SSH_PORT)
    ap.add_argument("--user", default=DEFAULT_USER)
    ap.add_argument("--pass", dest="password", default=os.environ.get("NGROK_SSH_PASS", ""))
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--restart", action="store_true", help="先重启 systemd ngrok 服务再读取")
    ap.add_argument("--dry-run", action="store_true", help="只打印会做的改动，不写文件不推送")
    ap.add_argument("--no-push", action="store_true", help="改 config.js 但不 git push")
    args = ap.parse_args()

    load_env_file(os.path.join(SCRIPT_DIR, ".ngrok_sync.env"))

    if not args.password:
        import getpass
        args.password = getpass.getpass(f"SSH 密码 ({args.user}@{args.host}): ")

    repo_root = SCRIPT_DIR

    print(f"[1/3] 连接 {args.user}@{args.host} 读取 ngrok 公网地址 ...")
    if args.restart:
        print("  重启隧道中 ...")
        st = restart_tunnel(args.host, args.port, args.user, args.password)
        print(f"  systemd 服务状态: {st}")
    url = get_public_url(args.host, args.port, args.user, args.password)
    if not url:
        print("  ✗ 没读到公网地址。隧道可能没起来，试试加 --restart，或检查 systemctl --user status qwen-ngrok")
        return 1
    print(f"  当前公网地址: {url}")

    print(f"[2/3] 改写 {args.config} 的 endpoint ...")
    old, new_text = patch_config(args.config, url)
    if old == url:
        print(f"  地址未变（仍是 {url}），无需改动")
    else:
        print(f"  {old}  ->  {url}")

    if args.dry_run:
        print("[3/3] --dry-run：未写文件、未推送。")
        return 0

    if old != url:
        with open(args.config, "w", encoding="utf-8") as f:
            f.write(new_text)
        print("  config.js 已更新")

    print("[3/3] git 提交 / 推送 ...")
    rel = os.path.relpath(args.config, repo_root)
    result = git_commit_push(repo_root, rel, url, args.no_push)
    print("  " + result)
    print(f"\n完成。演示页 endpoint 现在应为: {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
