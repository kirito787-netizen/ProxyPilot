# ProxyPilot

Windows 桌面代理切换工具，附浏览器扩展版本。通过系统级 PAC 脚本实现按域名分流：指定域名走代理，其余直连。Chrome、Edge 等所有遵守 Windows 系统代理设置的浏览器共用同一套规则。

## 功能

- 固定代理（HTTP / HTTPS / SOCKS4 / SOCKS5，支持认证）
- PAC 脚本（远程 URL 或内置脚本）
- 自动切换（主机通配符 / 正则、网址通配符 / 正则，按规则分流）
- 托盘菜单快速切换，主窗口一键切换
- 中英双语、深浅色主题
- 配置导入导出
- 退出时自动恢复系统代理原状

## 运行

要求 Node.js 18+。

```powershell
npm install
npm run build:slim
npm start
```

`build:slim` 会把当前源码打包为 `dist/ProxyPilot/ProxyPilot.exe`（便携版，约 220MB），并裁剪未使用的语言包与 GPU 组件。

首次启动后默认包含 `代理服务器`（`127.0.0.1:7890`）与 `自动切换`（`*.google.com` 走代理）两个情景。请在设置中按需修改，并将系统代理切换到 `自动切换` 情景。

## 测试

```powershell
npm run test:pac       # PAC 生成单元测试
npm run test:chrome    # Chrome 真实路由验证
npm run test:settings  # 设置窗口渲染回归
npm run test:exe       # EXE 端到端：系统 PAC + Chrome 分流
npm run test:web       # 浏览器扩展引擎冒烟测试
npm run sync:web       # 将 app/ 共享逻辑同步到 web/lib/（test:web 会检查漂移）
```

## 架构

- `desktop/` — Electron 主进程：Windows 代理注册表、PAC 服务（127.0.0.1:17777）、托盘、IPC
- `app/` — 渲染层：快速切换窗口与设置界面
- `web/` — 浏览器扩展（Manifest V3）：chrome.proxy 代理引擎、弹窗与设置页，详见 [web/README.md](web/README.md)
- `tools/` — 图标生成与端到端验证脚本

## 许可证

[MIT](LICENSE)
