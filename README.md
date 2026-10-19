<div align="center">

<img src="assets/hero.svg" alt="dsh-mobile — 手机端：手机扫码，在手机浏览器里看电脑上的 DSH 任务" width="760" />

<p>
  <a href="https://github.com/OrderG-X/dsh-mobile/releases"><img src="https://img.shields.io/github/v/release/OrderG-X/dsh-mobile?label=release&color=4D6BFE" alt="release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://img.shields.io/badge/DSH-plugin-4D6BFE" alt="DSH plugin" /></a>
</p>

<p>
  <a href="README.md"><b>简体中文</b></a> ·
  <a href="README.en.md">English</a>
</p>

</div>

DSH（DeepSeek Harness）的手机端：电脑上的 DSH 设置页里亮一个二维码，手机相机一扫，手机浏览器里就是电脑上的那个 DSH——同一批会话、实时同步。任务跑着的时候出门，也能在手机上看进度、接着发消息、点批准。

不用装 App，不用注册账号，也没有第三方服务器存你的数据：

- **同一个 Wi-Fi**：手机直接连电脑，打开就能用。
- **出门在外**：打开 Cloudflare 的免费隧道（不用注册），用流量也能连。
- **配对要扫码**：二维码只能用一次、10 分钟过期；每台手机一张凭证，设置页里随时移除，移除后那台手机立刻断开。

## 安装

```sh
dsh plugin add https://github.com/OrderG-X/dsh-mobile/releases/latest/download/dsh-mobile.tgz
```

装完**重启 DSH**。DSH「插件」页里显示为「手机端」。

## 怎么用

1. 电脑上：DSH →「插件」→「手机端」，打开「允许手机访问」。
2. 手机和电脑连同一个 Wi-Fi，用相机扫「同一 Wi-Fi」下面的二维码。
3. 想在外面用：切到「外网」→ 第一次先点「下载 cloudflared」（Cloudflare 官方程序，约 20 MB）→ 打开「开启外网访问」→ 扫这里的二维码。

扫过一次，之后在手机上直接打开那个地址就行（建议「添加到主屏幕」）。电脑重启 DSH 后：Wi-Fi 地址不变，不用重扫；外网地址每次都会变，要重扫一次。

## 原理

插件在 DSH 里起一个小网关（默认端口 18765），把手机的请求转给本机的 DSH 网页端。手机上跑的就是 DSH 官方网页界面，所以会话、审批、设置都和电脑上一模一样。

- DSH 桌面版的网页端要登录：网关在 DSH 进程里用启动口令换一张登录 Cookie，替手机带上；这张 Cookie 不会发到手机上。
- 手机自己的凭证是网关发的（HttpOnly、SameSite=Strict）。盘上只存它的哈希。
- 局域网是明文 HTTP，浏览器少了一些「安全上下文」才有的接口，网关会给页面补上 DSH 需要的那个。
- 长连接（实时事件）空闲时，网关往手机方向发保活包，免得被隧道或运营商当成死连接掐断。
- 外网用 `cloudflared tunnel --url`（trycloudflare.com 快速隧道）：Cloudflare 把 HTTPS 流量转到你电脑上的网关，门禁照旧是网关的配对。

## 安全

扫过码的手机能让 DSH 在这台电脑上干活，和你坐在电脑前一样。所以：

- 只用自己的手机扫，别把二维码发给别人、别截图到群里。
- 手机丢了，就在「已配对的手机」里移除它。
- 同一个 Wi-Fi 下走的是明文 HTTP：公共 Wi-Fi 上别用局域网模式，用外网（HTTPS）。
- 不用的时候关掉「允许手机访问」，网关就不监听了。

数据都在 `~/.dsh/dsh-mobile/`：`state.json`（开关）、`devices.json`（已配对的手机，0600）、`mobile.log`、`bin/cloudflared`（下载的话）。

## 限制

- 电脑睡眠或 DSH 关着时连不上。
- 手机上的界面就是 DSH 网页版，没有专门为手机重新排版。
- 外网用的是 Cloudflare 免费快速隧道，没有可用性保证；地址每次重启都会变。
- 只测过 macOS 上的 DSH 桌面版；Windows / Linux 上的 cloudflared 下载路径写了，没实测。

## 开发

```sh
npm test   # 网关、配对、长连接、保活的脚本测试
```

## License

MIT
