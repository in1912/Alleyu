# CLAUDE.md

本文件给 Claude Code 提供本仓库的作业指引。

## 项目

游巷 Alleyu — 自托管 AI 旅行攻略生成器（Express + node:sqlite + Vue3）。架构完全模仿 D:\cc\personal-workbench（工作台）：同样的 latestDist 静态服务、Bearer+?token= 双通道鉴权、EXEMPT 免登录前缀、allowed_pages 页面白名单。改本项目前若不熟悉这些模式，先看工作台对应实现。

## 常用命令

```bash
npm start                                     # 起 9610（start.bat 同效）；Node >= 22.5（node:sqlite）
ALLEYU_AI_STUB=1 node server/index.js         # 桩 AI 模式（不调外网；配了真 Key 仍走真接口）
node scripts/check-alleyu.mjs                 # 离线自检 83 项（独立临时 DATA_DIR，端口 9690）
node scripts/check-alleyu.mjs --online        # +4 项真实高德/Open-Meteo 断言（共 87）
NODE_PATH=D:\cc\personal-workbench\node_modules node scripts/render-alleyu.mjs   # Playwright 渲染自检（自起 FORCE_STUB 桩服务器，独占 9610）
cd web && npm run build                       # 前端 → dist/<时间戳>/ + .latest
```

Windows 注意：npm 卡住加 `--registry=https://registry.npmmirror.com`；重启服务用 `netstat -ano | grep ':9610'` 找 PID 再 `taskkill //F //PID <pid>`，**绝不要 `taskkill //IM node.exe`**（会杀用户其它 node 进程）。

## 数据与密钥

- 一切运行时数据在 `data/`（gitignore）：`alleyu.sqlite`、`.secret`（AES 密钥）、`mapimg/` 地图缓存。**amap key 与用户 AI key 都在库里，data/ 永不入 git。**
- AI key 落库 AES-256-GCM（`enc:v1:iv:tag:data`），接口只回 has_key。优先级：个人(base_url+model+key 全配齐) → 全局(settings) → 无。
- 默认管理员 admin/admin123 仅空库首启生效；生产改密码。

## 关键实现事实

- **node:sqlite 坑**：SQL 字符串字面量必须单引号；占位符个数必须精确；加列用 addCol 幂等模式；PRAGMA journal_mode=DELETE + busy_timeout + 事务包裹在 db.js。
- **EXEMPT 是相对路径**：`app.use('/api')` 内 req.path 不带 /api 前缀，EXEMPT=['auth/login','health','system-info','amap/mapimg','amap/photo']；system-info 另在顶层注册。
- **SSE=查库**：生成写库节流 ~600ms，stream 端点 400ms 轮询推增量；前端 GuideView 依赖 `streamed` ref（不是 content）。
- **SSE 内容协议=基线快照式（v1.4.0）**：tick 维护 `believed`（认为客户端已有的精确内容）——`c.startsWith(believed)` 走 `delta` 增量，否则（首拍/断线重连/enrich **顶部前插封面**改写内容）推 `reset` 全文快照。**旧纯 `slice(sent)` 协议的两个真 bug 就是它修的**：前插场景把中段文本当增量推、封面永远到不了前端；重连 `sent=0` 全文重复追加。前端 done 后以库内全文为准（长度比较不可靠）。
- **生成阶段管线（v1.4.0）**：guides.stage 列（weather/connect/write/retryN/enrich:子步骤），guideService setStage 写库、SSE 推 `stage` 事件、GuideView 进度条消费；done/error 清空。**过短自动重试（v1.5.0 收紧）**：`minChars = max(1200, days×300)`，循环只在 `content.trim().length >= minChars` 时 break——起因用户实测北京 7 日游真模型正常收流但只吐 600 字（v1.4.0 只拦「空」，短废稿照存）。半途断流且已有内容仍按失败 throw；3 次不达标报「不完整…请点重新生成」。**桩文案必须 ≥minChars**（stubGuideText ~1370 字，check 靠它不靠降闸门）。
- **高德 staticmap paths 格式**（实测验证过）：`8,0x3f7d5c,0.9,,:lng,lat;lng,lat` — 冒号在点串前、分号隔点、竖线隔多条线。免费 key 3 QPS → amapService 全局 350ms 串行节流，别拆。
- 照片代理 `/api/amap/photo?u=` 有域名白名单（amap/autonavi/mypeople/gaode 系）。
- 天气走 Open-Meteo 免 key：预报 16 天；历史用 archive 的 monthStats（一次多年调用+客户端同月过滤，sampleDays≥20 才可信）。预警是规则研判，UI 必须带"非官方预警"标注。
- 九模块框架模板在 guideService.js 的 FRAMEWORK 常量（用户原话模板，勿改结构）；提示词里要求 `### Day N｜主题` 标题格式，splitDays 靠它切天。
- 桩语义（v1.1.0 起）：**桩是兜底不是覆盖**——streamChat 只在 `!cfg || cfg.source==='stub'` 时走桩，个人/全局配齐了 Key 一律走真接口。ALLEYU_AI_STUB=1 只剩两个作用：设置页显示标记 + 放行 guideRoutes 的 AI 权限闸门（否则没配 key 时 400）。**ALLEYU_AI_FORCE_STUB=1 才是真强制**（resolveConfig 直接回桩 cfg，闸门也认）——起因 v1.5.0：本机 data/ 存着用户真 deepseek Key，render 的「现场生成」一直在打真实接口（首字 20s+、偶发空流），直播流断言随机红；render 现在自起 FORCE_STUB 服务器拿确定性（ALLEYU_URL 可改打外部）。桩流 25ms/行≈2.3s：必须跨过 600ms 落库节流窗，SSE 才有真 delta 可测（5ms/行整段落首窗内，直播只见一次 reset）。
- v1.5.0 四件套：①GuideView `.peek` 3 行实时小窗=streamed 尾巴 220 字符（进度条下、终端深色样式）；②封面偏蓝=蓝墨标记(0x0d47a8)+线(0x1565d8)+CSS `sepia(1) hue-rotate(190deg) saturate(1.5)`（用户定调不要黑白），静态图 size 默认 1000*580（实测上限 1200*800）；③`mapFit.fitView` 纯函数（无 db 依赖，测试可直接 require）：Web 墨卡托 bbox→zoom，EQUATOR_RES=156543.03392 m/px、padding 1.35、clamp 4~16、min 500m 跨度——高德 staticmap 无自动 fit，固定 zoom11 会裁散点（北京长城实测）；总览/日路线/封面三处调用；④guides.prompt 列存 JSON.stringify(messages,null,2)（setPrompt 在流式前落库，失败也留）、**只有详情接口回 prompt 列表不背**、GuideView 生成来源下默认折叠 details+复制；`POST /guides/:id/regenerate` 原地重置重跑（409 拦进行中）。cleanMd 同时剥 `<!-- alleyu:stub -->` 注释（不进 DOM/复制，披露交给生成来源页脚——桩模式页脚会如实写「本地桩输出」，render 断言别把它当桩横幅）。
- 封面与连线（v1.2.0，v1.5.0 改蓝调+自适应）：**封面=偏蓝单色全程路线地图，不再随机搜照片**——buildStaticMapUrl 传 `ink:true`（蓝墨标记/线，见上），前端 CSS 滤镜显示层压蓝，零图像处理依赖；总览图与封面都带全程连接线，`journeyLine()`=drivingPolyline 失败回落直连折线（**保证一定有线**）；点位顺序=正文首次出现顺序（findPoiMentions 按 indexOf 排序=行程顺序）。
- 生成来源页脚（v1.2.0）：run() 里 `enrichResult.content + sourceFooter(cfg)` 无条件追加——AI 模型/接口出处 + 高德/Open-Meteo 链接 + 时间戳，增强失败也交代。
- 侧栏图标（v1.1.1）：App.vue 的 ICONS 表=单色线性 SVG（stroke=currentColor 跟随文字色，激活变白），v-html 注入；favicon 与生成转圈=🐰；渲染自检的攻略详情截图只认「现场新生成」那篇（detailShotDone 标志，旧攻略是照片封面别拿去当 README 图）。
- 国际线路（v1.3.0）：cities.line 列（addCol 默认'国内'；线路白名单 LINES 在 cityRoutes）；db.js SEED_INTL=五线 58 城直接入库（城市挑选对齐参考站 tabiji.ai 覆盖，门票=「约」参考值，坐标 WGS-84 仅天气用），迁移 seedIntlLines 用 settings 标记 seed_intl_v1 **只跑一次，之后管理员删改不复活**；`GET /api/cities/lines` 汇总计数、`/cities?line=` 过滤；库页 LibraryView 线路 pill + 线路列 + 弹窗线路下拉。
- **国际线攻略护栏**：高德静态地图实测无海外底图（zoom4 也只渲染中国区域）→ enrichGuide 查城市 line，国际线直接 return（跳过 POI 解析/总览图/路线图/封面/照片），正文插一行「国际线路目的地…不插图」说明；天气（Open-Meteo 全球）+ AI 正文 + 生成来源页脚照常。attractions 新录时国际城不触发高德回填。
- 攻略展示净化（GuideView.cleanMd）：剥旧桩横幅 + 正文只从第一个 markdown 标题开始（AI 废话前言不显示不复制）；存储原文不动。
- 高德 Key 常见错误码人话提示在 settingsRoutes 的 AMAP_HINTS（10009=JS API 类型 Key 调不了 REST，真实踩坑）；`POST /settings/amap/test` 永远回 200+{ok,...}，`POST /settings/amap/reset` 恢复 db.js 的 DEFAULT_AMAP_KEY。
- SPA 挂载坑（App.vue）：登录是 SPA 内跳转，App 只挂载一次 → 必须 watch route.fullPath 补拉 /auth/me，否则从首页进任何功能页侧栏空菜单。渲染自检要用 SPA 流程（登录后不整页 goto），page.goto 会重挂 App 把这类 bug 藏住。
- 首页骑手是乳白兔子（RiderScene.vue，v1.0 的 PigScene.vue 已删）：浅色角色在浅色背景上，手臂用双层描边（#b3a68c 底衬 + #f6f1e5 乳白面层）保对比度。
- guides 严格 user_id 隔离（admin 也读不到他人的，by design）；城市/景点库全局共享。
- 前端 dist 随 git 分发（.gitignore 不忽略 web/dist/），Dockerfile COPY 依赖它；改前端必须 rebuild + commit。

## 发版收尾清单

1. 两个自检全绿（check 83/83 或 --online 87/87；render 39/39——render 前先停 9610 上的一切服务，它要独占端口自起桩服务器）
2. 改了前端 → rebuild，确认 dist/.latest 指向新目录
3. README 截图用 render-alleyu.mjs 重新生成（img/ 文件名=页面名）
4. 提交推送双远程：github `git@github.com:in1912/Alleyu.git` + gitea `https://gitea.in1912.cc/in1912/Alleyu.git`，push 后 ls-remote 核对
5. 临时文件清理：boot.log、login.json、_spec_extract.txt 等不入库（后两者已在 .gitignore）
