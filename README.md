# 游巷 Alleyu

自托管的 AI 旅行攻略生成器：填一张表单，出一篇带地图、照片、天气推演的九模块攻略。多用户、多权限，AI Key 谁的听谁的。

![首页](img/首页.png)

![攻略详情](img/攻略详情.png)

## 它能干什么

- **攻略生成**：按固定九模块框架输出（旅行总览 / 交通指南 / 住宿建议 / 每日详细行程 / 美食清单 / 门票&预约提醒 / 行前准备清单 / 避坑&安全贴士 / 可选拓展），信息落地、不走回头路。生成过程 SSE 流式可见。
- **图文并茂**：封面照片、总览地图、每日驾车路线图（高德静态地图折线）、景点实景照片自动插入正文，图不够的地方文字补。
- **天气**：未来 16 天逐日预报 + 近 5 年同月历史统计推演，附规则研判的出行提醒（非官方预警，页面明确标注）。
- **城市 / 景点库**：42 个种子城市、热门城市种子景点，边查边搜；景点坐标缺失时自动用高德补齐；管理员可批量从高德 POI 导入。
- **多租户多权限**：管理员配总 AI Key、按人开通 `can_use_ai`、按人收窄可见页面；用户可配自己的 Key，**个人 Key 优先，个人为空回落全局**。
- **首页封面**：乳白小兔骑车动画（粉内耳+小黄帽），打一个字跳一下（兔跳特技），场景无天空、直接融入页面背景。

## 快速开始

要求 Node ≥ 22.5（用了 `node:sqlite`）。

```bash
npm install            # Windows 慢就加 --registry=https://registry.npmmirror.com
npm start              # 或双击 start.bat；默认 9610 端口
```

打开 http://localhost:9610，默认账号 `admin / admin123`（**部署后立刻改密码**）。

Docker：

```bash
docker compose up -d
```

前端构建产物已随仓库分发（`web/dist/<时间戳>/`，`.latest` 指当前版），clone 即用；改前端才需要重新构建（见下）。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 9610 | 监听端口 |
| `DATA_DIR` | 项目下 `data/` | 数据库、密钥、地图图片缓存都在这 |
| `DEFAULT_ADMIN` / `DEFAULT_ADMIN_PASSWORD` | admin / admin123 | 仅空库首次启动生效 |
| `ALLEYU_AI_STUB` | — | 历史开关，现在只影响设置页显示标记。桩 AI 是「未配置任何 Key 时的兜底」：个人或全局配了 Key 一律走真接口，不会被它盖掉 |

运行后配置（界面「设置」页）：

- **AI**：OpenAI 兼容 `base_url + model + key`。管理员配全局，用户配个人；Key 落库前 AES-256-GCM 加密，接口只回 `has_key` 布尔，永不明文出服务端。
- **高德 Key**：**必须是「Web服务」类型的 Key**（lbs.amap.com 申请时选），「Web端(JS API)」类型调不了 REST 接口（infocode 10009）。只在服务端使用，不下发浏览器。已内置一个可用的默认 Key；换自己的之前先点「测试连通」，报错会给人话原因（配额/IP 白名单/类型不匹配），不行可一键「恢复内置」。

## 架构

```
server/                 Express + node:sqlite（单库，guides 按 user_id 隔离）
  auth.js               会话、页面权限白名单（allowed_pages 空=全开）
  crypto.js             AES-256-GCM（enc:v1:iv:tag:data），密钥在 data/.secret
  routes/               auth/users/ai/city/guide/amap/weather/settings 八组
  services/
    aiService.js        Key 解析（个人→全局）、SSE 流式对话、桩模式
    guideService.js     九模块框架模板、生成主流程、插图管线
    amapService.js      POI 检索/地理编码/静态地图，全局 350ms 串行节流
    weatherService.js   Open-Meteo 预报+历史归档，免 Key
web/                    Vue 3 + Vite（hash 路由）+ marked
  src/views/            首页(兔子场景)/表单/攻略/历史/城市景点库/天气/设置/用户管理
  dist/<时间戳>/         构建产物随仓库分发，.latest 标记当前版
scripts/
  check-alleyu.mjs      API 自检（--online 加真实外网断言）
  render-alleyu.mjs     Playwright 渲染自检 + 截图
```

几个值得知道的设计决定：

- **SSE 是查库不是转发的**：生成写库（节流 ~600ms），`GET /guides/:id/stream` 每 400ms 轮询推增量。断线重连不丢内容，刷新页面接着看。
- **图片管线**：静态地图 PNG 按 sha1 缓存在 `data/mapimg/`，免登录直链 `/api/amap/mapimg/<key>.png`；景点照片走 `/api/amap/photo?u=` 代理，域名白名单只有高德系。每个插图步骤独立 try/catch，图挂了文字攻略不受影响。
- **攻略私有**：guides 只归本人，管理员也读不到别人的（用户管理页能看到的只有账号信息）。
- **城市/景点库是全局共享的**：所有用户共用一份库，普通用户可以补录景点（管理员审核删除）。

## 重新构建前端

```bash
cd web && npm install && npm run build
```

产物进 `web/dist/<新时间戳>/` 并更新 `.latest`，服务端下次请求自动用新版。

## 自检

```bash
node scripts/check-alleyu.mjs            # 离线桩模式，41 项，起独立临时数据目录，不碰真实数据
node scripts/check-alleyu.mjs --online   # 追加 4 项真实外网（高德 POI / Key 连通测试 / Open-Meteo），消耗少量配额
NODE_PATH=<某个装了 playwright 的 node_modules> node scripts/render-alleyu.mjs   # 渲染+截图，要求 9610 已起服务
```

## 诚实的边界

- 天气「预警」是**规则研判**（对预报/历史统计跑阈值），不是气象台官方预警，页面写明了。
- 历史天气是多年同月**统计推演**，用来判断"3 月去昆明大概什么温度"，不是气候保证。
- 高德免费 Key 3 QPS：一篇多日攻略的配图（地图+照片十几次调用）串行下来要半分钟上下，插图在正文之后异步补，等图是正常的。
- 没配 AI Key 时走本地桩（模板造的假数据，只用来验证管线，别拿它出行）；配了 Key 一律走真接口。旧攻略里残留的桩提示横幅在展示时会自动剥掉，正文只从第一个框架标题开始显示——AI 废话前言不展示、复制也不带走。
- 没有做攻略的导出 PDF / 分享链接；复制全文按钮给的是 markdown 源码。
