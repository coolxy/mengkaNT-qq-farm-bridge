QQ农场助手桥接 v1.2.0
=====================

作用：把萌卡在线 QQ 的农场登录 code 自动/手动推送到 QQ农场智能助手（qq-farm-bot）。

安装
----
萌卡 WebUI →「插件服务」/「插件导入」→ 上传对应平台的 zip：
  Windows 版萌卡：qq-farm-bridge-1.2.0-windows-amd64.zip
  Linux 版萌卡  ：qq-farm-bridge-1.2.0-linux-amd64.zip
导入后勾选"来源可信"，并在卡片「配置」里填：
  农场面板地址  https://farm.qqai.ren:59443
  农场管理员     admin
  农场管理员密码  （secret，只存框架加密配置）

使用
----
1. 点卡片「管理后台」打开插件页面；
2. 页面右上角「⚡ 立即推送 code 到农场」= 立即为所有在线 QQ 取新 code 并推送；
3. 页面同时显示在线 QQ 列表与最近一次推送明细（成功/失败、耗时、原因）；
4. 插件按「自动推送间隔」分钟定时推送，账号上线后无需人工干预。

注意
----
* 农场面板里的账号备注需与 QQ 号完全一致，否则会新增账号而不是重新登录续登；
* get_qq_farm_code 仅 Android QQ 支持，Linux QQ 取码会失败（页面会标注），
  默认关闭 Linux 推送；
* 本包自带 node 运行时，不依赖系统 Node.js。
