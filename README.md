# Cloudflare 代理说明

一个基于 Express + Puppeteer 的简单代理，用于绕过 Cloudflare 挑战并为下游（如 Koishi 插件）提供可复用的 `cf_clearance`。

## 快速开始

```bash
npm install
# 如果不想下载浏览器，使用系统 Chrome/Chromium：
PUPPETEER_SKIP_DOWNLOAD=1 \
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
WAIT_MS=12000 \
node proxy.js
```

主要环境变量：
- `UPSTREAM`：上游站点，默认 `https://mapleranks.com`
- `PORT`：代理监听端口，默认 `3000`
- `UA`：请求 UA，需与 Koishi 配置一致
- `WAIT_MS`：等待 CF JS 挑战的时间，默认 `8000`
- `DEBUG_PORT`：手动模式的远程调试端口，默认 `9223`
- `PUPPETEER_EXECUTABLE_PATH`：使用系统浏览器时指定可执行路径
- `PUPPETEER_SKIP_DOWNLOAD`：设为 `1` 跳过下载浏览器
- `CF_COOKIE`：可选，预置已有的 `cf_clearance=...; __cf_bm=...` 等

## 手动获取 cf_clearance（本机有界面）

1. 启动服务（可设 `WAIT_MS` 拉长等待）。  
2. 访问 `http://127.0.0.1:3000/manual/refresh?path=/u/leslee521`（替换为目标路径），弹出的窗口里完成 CF 验证。  
3. 等几秒查看 `http://127.0.0.1:3000/status`，`hasCookie: true` 即成功。若仍为 false，访问 `http://127.0.0.1:3000/manual/pull` 强制读取当前浏览器 Cookie。

## 无界面服务器获取（通过远程 DevTools）

1. 安装系统 Chrome/Chromium（如 `/usr/bin/chromium-browser`），必要时使用 `xvfb-run`：  
   ```bash
   PUPPETEER_SKIP_DOWNLOAD=1 \
   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
   WAIT_MS=12000 \
   DEBUG_PORT=9223 \
   xvfb-run -a node proxy.js
   ```
2. SSH 建立隧道：`ssh -L 9223:127.0.0.1:9223 user@server`。  
3. 本机浏览器打开 `http://127.0.0.1:3000/manual/refresh?path=/u/leslee521` 获取 `wsEndpoint`，再在本机 Chrome 的 `chrome://inspect` 添加 `localhost:9223`，连接目标页手动完成验证。  
4. 查看 `/status`，为 true 即成功；必要时调用 `/manual/pull`。

## 在 Koishi 中使用

- `mapleranksBaseUrl`：`http://<服务器>:3000/proxy`
- `mapleranksCookie`：留空（由代理维护）
- `mapleranksUserAgent`：与脚本 `UA` 保持一致

代理会先用缓存 Cookie 请求，403 或检测到 CF 挑战会自动 headless 刷新。遇到 Turnstile/验证码时，需按上述“手动”流程过一次。Cookie 失效后可重复手动流程或预置 `CF_COOKIE`。***
