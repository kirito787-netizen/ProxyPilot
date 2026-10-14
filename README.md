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

### 便携版

`dist/ProxyPilot/` 目录即开即用、无需安装：整个文件夹拷到任意位置（包括 U 盘）后直接运行 `ProxyPilot.exe`。目录中的 `portable.marker` 使应用把全部数据（配置、统计、订阅）保存在旁边的 `data\` 文件夹里，随目录一起移动；删除该文件则恢复按用户 AppData 存放（与安装版一致）。

首次启动后默认包含 `代理服务器`（`127.0.0.1:7890`）与 `自动切换`（`*.google.com` 走代理）两个情景。请在设置中按需修改，并将系统代理切换到 `自动切换` 情景。

## 测试

```powershell
npm run test:pac       # PAC 生成单元测试
npm run test:chrome    # Chrome 真实路由验证
npm run test:system    # 系统代理真实路径：Chrome 不带代理参数跟随系统 PAC
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

## 故障排查：Chrome 不走代理

桌面版通过系统 PAC 分流，Chrome、Edge 等默认跟随系统代理。若 Chrome 实际没有走代理，几乎都是被浏览器内的代理扩展覆盖了：chrome.proxy 设置（SwitchyOmega、SetupVPN、各种 VPN 扩展等）一旦写入，浏览器就会完全无视系统代理。

- ProxyPilot 扩展 1.1.0 起支持自动让位：探测到桌面版运行（http://127.0.0.1:17777/proxypilot.state）时清除自己的代理设置，角标显示 DT，浏览器跟随桌面版系统 PAC；桌面版退出后一分钟内自动恢复接管
- Chrome 里若还装着旧版 ProxyPilot 扩展或第三方代理扩展，请在 chrome://extensions 停用，或重新加载本仓库 web/ 的新版扩展
- Edge 会周期性自动关闭「开发者加载」的扩展（提示「已关闭来自未知来源的扩展」）：在 `edge://extensions` 打开「开发人员模式」并重新启用 ProxyPilot，详见 [web/README.md](web/README.md)
- 验证方法：Windows 设置中的代理应显示「使用设置脚本 http://127.0.0.1:17777/proxypilot.pac」，且 npm run test:system 通过

## 两版共存：优先级与规则同步

桌面版与扩展版同时运行时，桌面版优先：扩展自动让位（角标 DT），退出桌面版后扩展在一分钟内自动恢复接管。同时双方互相可见，可手动同步规则：

- 扩展弹窗在桌面版接管期间显示「从桌面版同步规则」，点击即把桌面版的情景与规则导入扩展（主题、语言、订阅等本地设置保留）
- 桌面版主窗口检测到扩展心跳（约每分钟一次，携带扩展当前情景）后显示「同步扩展版规则」，点击即把扩展的情景与规则导入桌面版
- 同步语义与「配置订阅」一致：整体替换情景表；若当前情景在导入后不存在，则回到「直接连接」
## 许可证

[MIT](LICENSE)
