# 代码来源与署名

## 自研部分（本项目新增）

- desktop/：Electron 桌面壳、Windows 系统 PAC 控制、托盘、IPC 桥接
- tools/qa/：PAC、Chrome 与真实 EXE 的自动化验证脚本
- package.json、README-DESKTOP.md
- src/common/proxy.js 中的 buildSystemPac（系统级 PAC 生成）

## 衍生自 Edge 扩展的部分

以下内容来自 Edge 扩展商店中的 "ProxyPilot · 代理切换"（发布者昵称 dacainiao，
扩展 ID fjlobaapeljdappiedcjjakionkjnopp）：

- src/popup/、src/options/、src/common/（除 buildSystemPac 外）、manifest.json、icons/

经 GitHub、Gitee 与多个搜索引擎检索，未找到该扩展的公开源码仓库或开源许可证。
按照版权默认规则，未附带许可证的代码默认保留所有权利。公开分发上述衍生部分前，
建议先通过 Edge 商店的扩展页面联系发布者取得授权，或以自己的原创实现替换相应代码。
