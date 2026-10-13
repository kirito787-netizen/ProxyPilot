# ProxyPilot 桌面版

桌面版通过 Windows 的系统自动代理脚本（PAC）工作。应用启动本机 PAC 服务，然后把 Windows 的自动配置脚本设置为：

`http://127.0.0.1:17777/proxypilot.pac`

自动切换情景命中指定域名时返回上游代理，其他域名返回 `DIRECT`。因此 Chrome、Edge 以及遵守 Windows 系统代理设置的浏览器可以共用规则。

## 运行

```powershell
npm install
npm start
```

默认配置包含 `代理服务器`（`127.0.0.1:7890`）和 `自动切换`（`*.google.com` 走代理，其他域名直连）。请在设置中改成实际代理地址，并保持 `自动切换` 为当前情景。

桌面版关闭时会恢复启动前的 Windows 代理设置。自动化验证使用 Chrome，Edge 用于人工确认命中规则和未命中规则的域名访问。

## 打包

```powershell
npm run dist
```

说明：系统 PAC 只能选择代理端点，不能注入 HTTP 代理的用户名和密码。带认证的上游代理需要增加本地转发代理层；当前桌面版先支持无认证 HTTP、HTTPS 和 SOCKS 代理。
