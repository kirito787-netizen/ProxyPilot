# ProxyPilot 浏览器扩展

ProxyPilot 的浏览器扩展版本（Chrome / Edge 等 Chromium 内核浏览器，Manifest V3）。与桌面版共享同一套情景模型：固定代理、PAC 脚本、自动切换规则，直接在浏览器内生效，无需修改系统代理。

## 安装（开发者模式加载）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库的 `web/` 文件夹
4. 工具栏出现 ProxyPilot 图标，点击弹出快速切换面板

## 功能

- 情景模式：直接连接、跟随系统、固定代理（HTTP / HTTPS / SOCKS4 / SOCKS5，支持认证）、PAC 脚本（远程 URL 或内置脚本）、自动切换（主机 / 网址通配符与正则规则）
- 弹窗快速切换，数字键 1-9 直达；首页可对当前标签页域名一键添加分流规则
- 图标角标实时显示当前情景名称与颜色
- 代理服务器认证自动应答（webRequestAuthProvider）
- 设置页管理情景、规则、外观（深浅色 / 中英双语）、配置导入导出
- 桌面版导出的 JSON 备份可直接导入

## 与桌面版的对应关系

| 桌面版 | 扩展版 |
| --- | --- |
| Windows 注册表写入系统 PAC | chrome.proxy API（浏览器内生效） |
| 本地 PAC 服务 127.0.0.1:17777 | PAC 脚本数据直接注入 |
| 「系统代理」恢复注册表备份 | 「跟随系统」交还浏览器默认（继承系统代理） |
| 托盘菜单 | 工具栏弹窗 + 图标角标 |
| 卸载时恢复系统代理 | 浏览器在扩展移除时自动还原其代理设置 |

## 权限说明

- proxy / storage — 应用情景与保存配置
- tabs — 读取当前标签页域名，用于「当前站点快速分流」
- webRequest + webRequestAuthProvider — 代理服务器要求认证时自动提交凭据

## 结构

- background/engine.js — 代理引擎：情景到 chrome.proxy 的映射、认证应答、消息枢纽
- lib/ — 与桌面版共享的模型、PAC 生成、站点匹配、i18n（改桌面端对应文件后运行 npm run sync:web 同步；npm run test:web 会检查两边是否一致）
- popup/ — 快速切换弹窗
- options/ — 设置页

## 测试

仓库根目录执行：

```powershell
npm run test:web
```
