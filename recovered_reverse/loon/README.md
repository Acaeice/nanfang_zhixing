# 南方智行 Loon 验证脚本

## 文件

- `nanfang_subscription_verify.js`
  - Loon 响应脚本本体
- `nanfang_subscription_verify.conf`
  - Loon 配置片段模板

## 用途

这个脚本不是为了“伪造一个固定会员状态”，而是为了验证我们恢复出的判断链路是否正确：

1. 先用 `observe-full` 模式观察真实命中的接口和字段原值
2. 再用 `active / warn7 / expired` 注入不同到期时间
3. 在手机上打开南方智行 App，检查电子围栏、震动设防、车辆共享、历史轨迹、OTA、车辆诊断是否随订阅状态变化

## 已恢复出的高价值线索

- 主判定字段：
  - `tboxExpireTime`
  - `vipExpire`
- 关联字段：
  - `memberId`
  - `memberName`
  - `expireBeginTime`
  - `expireEndTime`
- 关联接口线索：
  - `/blade-system/dict-biz/dictionary?code=car_subscribe_time`
  - `/iot-device-saas-car/carpayrecord/page`
  - `/iot-device-saas-car/carpayrecord/save`
  - `/payment/buyer/cashier/pay`
  - `/payment/buyer/cashier/result`

## Loon 使用方法

1. 把 `nanfang_subscription_verify.js` 导入到 Loon 本地脚本。
2. 打开 `nanfang_subscription_verify.conf`。
3. 把 `%SCRIPT_PATH%` 替换成你在 Loon 中该脚本的实际路径或 URL。
4. 导入该配置片段并启用。
5. 打开 Loon 的 `MITM` 并确保目标域名已被解密。

## 推荐验证顺序

### 新参数

- `mode=observe | observe-full | active | warn7 | expired`
- `strict=1`
  - 默认值，表示只改真实响应里原本就存在的字段
  - 这个模式更适合确认源码逻辑，避免“瞎塞字段”导致误判
- `strict=0`
  - 只在已经确认 URL 正确、但服务端返回结构不稳定时再用
- `target=both | tbox | vip`
  - `both`：同时改 `tboxExpireTime` 和 `vipExpire`
  - `tbox`：只改 `tboxExpireTime`
  - `vip`：只改 `vipExpire`

### 第一步：观察真实接口

把配置里的 `argument` 保持为：

```text
argument="mode=observe-full&notify=1&strict=1&target=both"
```

然后在手机里：

1. 登录南方智行
2. 打开“我的 / 服务订阅”
3. 依次进入：
   - 电子围栏
   - 震动设防
   - 车辆共享
   - 历史轨迹
   - OTA
   - 车辆诊断

预期结果：

- Loon 会弹通知，显示哪些 URL 命中了订阅相关字段
- 日志里会直接打印命中的字段路径和原始值
- 如果多次命中 `user/detail`、`vehicle/detail`、`car/detail`、`car/page` 一类接口，说明我们恢复的字段来源方向基本正确

### 第二步：验证“已过期”是否真能锁功能

把配置里的 `argument` 改成：

```text
argument="mode=expired&notify=1&strict=1&target=both"
```

预期结果：

- 响应中的 `tboxExpireTime` / `vipExpire` 会被改成过去时间
- 如果原 App 逻辑确实主要依赖这些字段，那么上述受限功能页应出现明显的不可用、续费提示、跳转订阅页或相关拦截

### 第二点五步：拆开验证到底用哪个字段

如果你要更快确认“到底是 `tboxExpireTime` 还是 `vipExpire` 在起作用”，直接做这两轮：

```text
argument="mode=expired&notify=1&strict=1&target=tbox"
```

```text
argument="mode=expired&notify=1&strict=1&target=vip"
```

结论判断：

- 只改 `tboxExpireTime` 就触发功能锁定：优先还原 `tboxExpireTime`
- 只改 `vipExpire` 就触发功能锁定：优先还原 `vipExpire`
- 两个都要改才触发：源码里大概率有回退或并行判断

### 第三步：验证“恢复有效期”是否能重新放开功能

把配置里的 `argument` 改成：

```text
argument="mode=active&notify=1&strict=1&target=both"
```

预期结果：

- 前一步被锁的功能应恢复可进入或可操作

### 第四步：验证“7天预警”

把配置里的 `argument` 改成：

```text
argument="mode=warn7&notify=1&strict=1&target=both"
```

预期结果：

- 如果原 App 存在 `SERVICEEXPIRED7` 的预警行为，可能会出现“即将到期”的提示，但不一定完全锁功能

## 验证结论怎么判断

如果出现下面现象，说明我们恢复的逻辑方向是对的：

- 改 `tboxExpireTime` / `vipExpire` 后，多个车辆在线能力页面同步发生变化
- 变化并不依赖重新登录，只依赖接口刷新
- 受影响页面集中在：
  - 电子围栏
  - 震动设防
  - 车辆共享
  - 历史轨迹
  - OTA
  - 车辆诊断

如果 `observe` 模式发现真正命中的字段或接口和当前恢复结果不一致，把 Loon 的命中 URL 和返回字段结构给我，我就继续把恢复工程往真实逻辑修正。

如果你把 `observe-full` 的命中日志和 `target=tbox/vip` 两轮对比结果发我，我可以把恢复工程里的判断逻辑从“高可信推断”继续收敛到“几乎可以直接落源码”的级别。
