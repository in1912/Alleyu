# CLAUDE.md

本文件给 Claude Code 提供本仓库的作业指引。

## 项目

游巷 Alleyu — 自托管 AI 旅行攻略生成器（Express + node:sqlite + Vue3）。架构完全模仿 D:\cc\personal-workbench（工作台）：同样的 latestDist 静态服务、Bearer+?token= 双通道鉴权、EXEMPT 免登录前缀、allowed_pages 页面白名单。改本项目前若不熟悉这些模式，先看工作台对应实现。

## 常用命令

```bash
npm start                                     # 起 9610（start.bat 同效）；Node >= 22.5（node:sqlite）
ALLEYU_AI_STUB=1 node server/index.js         # 桩 AI 模式（不调外网；配了真 Key 仍走真接口）
node scripts/check-alleyu.mjs                 # 离线自检 181 项（独立临时 DATA_DIR，端口 9690）
node scripts/check-alleyu.mjs --online        # +4 项真实高德/Open-Meteo 断言（共 185）
node scripts/render-alleyu.mjs                # Playwright 渲染自检 89 项（自起 FORCE_STUB 桩服务器，独占 9610；playwright 已是 devDependency）
cd web && npm run build                       # 前端 → dist/<时间戳>/ + .latest
```

Windows 注意：npm 卡住加 `--registry=https://registry.npmmirror.com`；重启服务用 `netstat -ano | grep ':9610'` 找 PID 再 `taskkill //F //PID <pid>`，**绝不要 `taskkill //IM node.exe`**（会杀用户其它 node 进程）。

## 数据与密钥

- 一切运行时数据在 `data/`（gitignore）：`alleyu.sqlite`、`.secret`（AES 密钥）、`mapimg/` 地图缓存。**amap key 与用户 AI key 都在库里，data/ 永不入 git。**
- AI key 落库 AES-256-GCM（`enc:v1:iv:tag:data`），接口只回 has_key。**v1.6.0 起全站只有管理员全局一份 Key**（settings 表 ai_key/ai_base_url/ai_model）；个人配置端点已删（/ai/config、/ai/test → 404），resolveConfig() 无参。Key 保存走 cleanKey（剥全部空白，不只 trim）。
- 默认管理员 admin/admin123 仅空库首启生效；生产改密码。

## 关键实现事实

- **node:sqlite 坑**：SQL 字符串字面量必须单引号；占位符个数必须精确；加列用 addCol 幂等模式；PRAGMA journal_mode=DELETE + busy_timeout + 事务包裹在 db.js。**SQLite 默认不强制 FK**：删攻略必须手动 `DELETE FROM shares WHERE guide_id=?`（guideRoutes DELETE 里做了）。
- **EXEMPT 是相对路径**：`app.use('/api')` 内 req.path 不带 /api 前缀，EXEMPT=['auth/login','health','system-info','amap/mapimg','amap/photo','share']；system-info 另在顶层注册。share 前缀整段免登录（公开分享页 `GET /api/share/:token`），但响应只回 title/mode/content/updated_at——prompt/params/images 永不下发。
- **SSE=查库**：生成写库节流 ~600ms，stream 端点 400ms 轮询推增量；前端 GuideView 依赖 `streamed` ref（不是 content）。
- **SSE 内容协议=基线快照式（v1.4.0）**：tick 维护 `believed`（认为客户端已有的精确内容）——`c.startsWith(believed)` 走 `delta` 增量，否则（首拍/断线重连/enrich **顶部前插封面**改写内容）推 `reset` 全文快照。**旧纯 `slice(sent)` 协议的两个真 bug 就是它修的**：前插场景把中段文本当增量推、封面永远到不了前端；重连 `sent=0` 全文重复追加。前端 done 后以库内全文为准（长度比较不可靠）。
- **生成阶段管线（v1.4.0）**：guides.stage 列（weather/connect/write/retryN/enrich:子步骤），guideService setStage 写库、SSE 推 `stage` 事件、GuideView 进度条消费；done/error 清空。**过短自动重试（v1.5.0 收紧）**：`minChars = max(1200, days×300)`，循环只在 `content.trim().length >= minChars` 时 break——起因用户实测北京 7 日游真模型正常收流但只吐 600 字（v1.4.0 只拦「空」，短废稿照存）。半途断流且已有内容仍按失败 throw；3 次不达标报「不完整…请点重新生成」。**桩文案必须 ≥minChars**（stubGuideText ~1370 字，check 靠它不靠降闸门）。
- **高德 staticmap paths 格式**（实测验证过）：`8,0x3f7d5c,0.9,,:lng,lat;lng,lat` — 冒号在点串前、分号隔点、竖线隔多条线。**markers 上限 9 个**（2026-10-15 实测：第 10 个起回 `20003 UNKNOWN_ERROR`；旧 Key 曾容忍 10，新 Key 按文档严校验——guideService 总览/封面均 slice(0,9)）。免费 key 3 QPS → amapService 全局 350ms 串行节流，别拆。
- **v1.6.4 配图兜底（起因：青岛攻略零图）**：两个独立根因——①新 Key 严校验（见上 9 标记上限，另 paths 必须带冒号、裸坐标 markers 被拒，buildStaticMapUrl 的格式本来就对）；②城市景点库为空时 findPoiMentions 命中 0 点 → 配图管线整体跳过（青岛库=0 条）。修法：enrichGuide 里库空则 `amap.searchPoi({keywords:'景点',city,offset:25})` 兜底当库（真名+坐标+照片一次到位），必去景点 resolvePoi 后优先 unshift；findPoiMentions 加第三参 fuzzyPrefix（仅兜底库启用）——高德 POI 全名「八大关风景区」正文写「八大关」时按名字前缀（长→短最少 2 字）匹配。**enrichGuide 已导出**（e2e 用临时行 99 直调验证 14 图，完事删行）。
- 照片代理 `/api/amap/photo?u=` 有域名白名单（amap/autonavi/mypeople/gaode 系）。
- 天气走 Open-Meteo 免 key：预报 16 天；历史用 archive 的 monthStats（一次多年调用+客户端同月过滤，sampleDays≥20 才可信）。预警是规则研判，UI 必须带"非官方预警"标注。
- 九模块框架模板在 guideService.js 的 FRAMEWORK 常量（用户原话模板，勿改结构）；提示词里要求 `### Day N｜主题` 标题格式，splitDays 靠它切天。
- 桩语义（v1.1.0 起）：**桩是兜底不是覆盖**——streamChat 只在 `!cfg || cfg.source==='stub'` 时走桩，个人/全局配齐了 Key 一律走真接口。ALLEYU_AI_STUB=1 只剩两个作用：设置页显示标记 + 放行 guideRoutes 的 AI 权限闸门（否则没配 key 时 400）。**ALLEYU_AI_FORCE_STUB=1 才是真强制**（resolveConfig 直接回桩 cfg，闸门也认）——起因 v1.5.0：本机 data/ 存着用户真 deepseek Key，render 的「现场生成」一直在打真实接口（首字 20s+、偶发空流），直播流断言随机红；render 现在自起 FORCE_STUB 服务器拿确定性（ALLEYU_URL 可改打外部）。桩流 25ms/行≈2.3s：必须跨过 600ms 落库节流窗，SSE 才有真 delta 可测（5ms/行整段落首窗内，直播只见一次 reset）。
- v1.5.0 四件套：①GuideView `.peek` 3 行实时小窗=streamed 尾巴 220 字符（进度条下、终端深色样式）；②封面偏蓝=蓝墨标记(0x0d47a8)+线(0x1565d8)+CSS `sepia(1) hue-rotate(190deg) saturate(1.5)`（用户定调不要黑白），静态图 size 默认 1000*580（实测上限 1200*800）；③`mapFit.fitView` 纯函数（无 db 依赖，测试可直接 require）：Web 墨卡托 bbox→zoom，EQUATOR_RES=156543.03392 m/px、padding 1.35、clamp 4~16、min 500m 跨度——高德 staticmap 无自动 fit，固定 zoom11 会裁散点（北京长城实测）；总览/日路线/封面三处调用；④guides.prompt 列存 JSON.stringify(messages,null,2)（setPrompt 在流式前落库，失败也留）、**只有详情接口回 prompt 列表不背**、GuideView 生成来源下默认折叠 details+复制；`POST /guides/:id/regenerate` 原地重置重跑（409 拦进行中）。cleanMd 同时剥 `<!-- alleyu:stub -->` 注释（不进 DOM/复制，披露交给生成来源页脚——桩模式页脚会如实写「本地桩输出」，render 断言别把它当桩横幅）。
- 封面与连线（v1.2.0，v1.5.0 改蓝调+自适应）：**封面=偏蓝单色全程路线地图，不再随机搜照片**——buildStaticMapUrl 传 `ink:true`（蓝墨标记/线，见上），前端 CSS 滤镜显示层压蓝，零图像处理依赖；总览图与封面都带全程连接线，`journeyLine()`=drivingPolyline 失败回落直连折线（**保证一定有线**）；点位顺序=正文首次出现顺序（findPoiMentions 按 indexOf 排序=行程顺序）。
- 生成来源页脚（v1.2.0）：run() 里 `enrichResult.content + sourceFooter(cfg)` 无条件追加——AI 模型/接口出处 + 高德/Open-Meteo 链接 + 时间戳，增强失败也交代。
- 侧栏图标（v1.1.1）：App.vue 的 ICONS 表=单色线性 SVG（stroke=currentColor 跟随文字色，激活变白），v-html 注入；favicon 与生成转圈=🐰；渲染自检的攻略详情截图只认「现场新生成」那篇（detailShotDone 标志，旧攻略是照片封面别拿去当 README 图）。
- 国际线路（v1.3.0；**v1.7.0 起线路不再白名单**）：cities.line 列（addCol 默认'国内'；cityRoutes 的 normLine 软校验=任意非空 ≤20 字收、空='国内'，前端种子六线只是 datalist 建议项+动态合并库内现存线路 allLines computed）；db.js SEED_INTL=五线 58 城直接入库（城市挑选对齐参考站 tabiji.ai 覆盖，门票=「约」参考值，坐标 WGS-84 仅天气用），迁移 seedIntlLines 用 settings 标记 seed_intl_v1 **只跑一次，之后管理员删改不复活**；`GET /api/cities/lines` 汇总计数、`/cities?line=` 过滤；库页 LibraryView 线路 pill + 线路列 + 弹窗线路自由输入（datalist）。
- **v1.7.0 景点分页+信息扩容**：attractions 加 intro/intro_source/intro_url/address/rating 五列（addCol 幂等）；跨城市分页端点 `GET /api/attractions?line=&city_id=&q=&page=&page_size=`（默认 10 上限 100，越界页钳尾页，ORDER BY must DESC+国内优先）；/cities 带 attr_count 子查询。**wikiService**（zh.wikivoyage.org 优先→zh.wikipedia.org 兜底，MediaWiki API 免 Key、200ms 串行节流、条目首段 ≤800 字、ALLEYU_WIKI_OFFLINE=1 直接 throw 防离线自检偷跑真网——高德的老教训）；PUT /attractions/:id 的 intro_source/intro_url **显式传才改**（CC BY-SA 署名跟随文本）；`POST /attractions/:id/enrich-intro` 单条补介绍、`POST /cities/:id/backfill` 一键补全（国内=高德 types=110000 风景名胜两页导入 upsertPoi 同名跳过 + 全市缺介绍补维基上限 40/次；国际线只补介绍——高德无海外 POI；错误全进 intro_error 不炸）。libraryBlock 把介绍前 80 字喂进提示词；sourceFooter 查 DISTINCT intro_source 追加「景点介绍引用：…（CC BY-SA 4.0）」致谢行。**check 断言教训（v1.7.0 调试半天的唯一根因）：断言里把 `attraction` 拼成 `attrraction`（三个 r）→ undefined 恒假，服务端从头就是对的——回包键名先 grep 核对再写断言，别往并发/锁方向想。**
- **国际线攻略护栏**：高德静态地图实测无海外底图（zoom4 也只渲染中国区域）→ enrichGuide 查城市 line，国际线直接 return（跳过 POI 解析/总览图/路线图/封面/照片），正文插一行「国际线路目的地…不插图」说明；天气（Open-Meteo 全球）+ AI 正文 + 生成来源页脚照常。attractions 新录时国际城不触发高德回填。
- 攻略展示净化（web/src/md.js 的 cleanMd，GuideView/ShareView 共用）：剥旧桩横幅 + `<!-- alleyu:stub -->` 注释 + 正文只从第一个 markdown 标题开始（AI 废话前言不显示不复制）；存储原文不动。
- **v1.6.0 分享系统**：`shares` 表（guide_id/token 32hex/mode dynamic|static/snapshot）DDL 在 db.js；管理端点全在 guideRoutes（GET/POST `/:id/shares`、PUT/DELETE `/:id/shares/:token`，全部 user_id 隔离+done-only 409），公开读在 shareRoutes（EXEMPT）。动态=现读 guides.content（攻略非 done 时 404「稍后再试」），静态=读 snapshot（PUT 刷新）。前端 ShareView（#/s/:token，router 守卫豁免 name==='share'，App.vue 整页无侧栏）；GuideView 分享对话框（创建即复制链接）+ 编辑模式（改 clean 后原文存库）。
- **v1.6.1 导出 PDF=服务端直出下载文件**（用户明确否掉 window.print）：`GET /api/guides/:id/pdf`（本人+done-only 409）与 `GET /api/share/:token/pdf`（EXEMPT 免登录，内容口径与 GET /:token 一致：静态=快照/动态=现读），都回 `Content-Disposition: attachment; filename*=UTF-8''<urlencoded 标题>.pdf`。生成在 `services/pdfService.js`：marked.lexer 词法树逐块绘制（h1-3/段落/列表/表格/引用/hr/code），行内样式摊平成 runs 用 pdfkit continued 链混排（strong→bold/link 蓝下划线/codespan 橙），图片预载（/api/amap/mapimg/ 直读 data/mapimg 本地缓存、photo 代理解码后 fetch、外链 15s 超时 8MB 上限、只收 PNG/JPEG、单图失败占位符不拦整份），页脚页码用 bufferedPageRange+switchToPage 回写。**中文字体探测顺序=data/fonts/*.{ttf,otf} → ALLEYU_PDF_FONT → Windows Deng.ttf（粗体对 Dengb.ttf）→ simhei.ttf → Linux 思源黑体 OTF；.ttc 一律排除**（fontkit 对集合缺 createSubset，msyh.ttc 实测崩），没有字体抛 NO_FONT→路由 400 {code}→前端 confirm 后回落 window.print()（打印 CSS 保留是兜底不是主路径）。前端下载封装在 api/index.js 的 downloadPdfFile（fetch→blob→a[download]，按钮带「生成中…」busy 态）。
- **v1.6.0 两个真 bug 的根因（都实测验证过）**：①deepseek-flash 是推理模型——`max_tokens` 预算被 reasoning_content 吃光导致正文空/极短（探针：200 tokens 全进思考、content 0 字、finish=length）→ streamChat 请求体固定带 `thinking:{type:'disabled'}`（`reasoning_effort:'none'` 等效；`enable_thinking`/`chat_template_kwargs` 对 deepseek 无效）；②全局 Key 401=用户粘贴丢了 `sk-` 前缀（32hex vs 35 字符同尾巴，服务商报错只回 `****a9f1` 看不出）→ testConnection 401 且 Key 是裸 32hex 时提示「像是粘贴时丢了开头」+ 前端 Key 输入框非 sk- 开头实时黄字提醒。
- 高德 Key 常见错误码人话提示在 settingsRoutes 的 AMAP_HINTS（10009=JS API 类型 Key 调不了 REST，真实踩坑）；`POST /settings/amap/test` 永远回 200+{ok,...}，`POST /settings/amap/reset` 清空 Key（**v1.6.3 起无内置默认 Key**——历史内置值属个人 Key 已从全 git 历史清除，env AMAP_KEY 只在首次空库种子生效）。
- SPA 挂载坑（App.vue）：登录是 SPA 内跳转，App 只挂载一次 → 必须 watch route.fullPath 补拉 /auth/me，否则从首页进任何功能页侧栏空菜单。渲染自检要用 SPA 流程（登录后不整页 goto），page.goto 会重挂 App 把这类 bug 藏住。
- 首页骑手是乳白兔子（RiderScene.vue，v1.0 的 PigScene.vue 已删）：浅色角色在浅色背景上，手臂用双层描边（#b3a68c 底衬 + #f6f1e5 乳白面层）保对比度。
- guides 严格 user_id 隔离（admin 也读不到他人的，by design）；城市/景点库全局共享。
- 前端 dist 随 git 分发（.gitignore 不忽略 web/dist/），Dockerfile COPY 依赖它；改前端必须 rebuild + commit。
- **v1.8.0 游记整理**：journals/journal_photos 两表（meta_json/spots_json 存问答与景点勾选；迁移=CREATE TABLE IF NOT EXISTS 幂等）；journalRoutes（照片 base64 JSON 上传 route 级 40mb 解析器——**全局 express.json 必须 ≥12mb**，8MB 照片 base64 ~10.7mb，全局 2mb 会在到达 route 前被 413 掐掉（v1.8.0 实测踩坑：route 级 limit 实际是兜底、全局 parser 先跑）；magic byte 校验、8MB/张按解码真实字节数、原图落 `data/journal_photos/<id>/`）；journalService（buildMessages 问答→提示词、照片以 `- [景点] 图N：配文` 行进上下文、正文图片用 `![说明](photo:N)` 占位 **N=照片 sort 值**、captionMessages 30字/参考用户稿两态、titleMessages ≤20字、run() 与 guideService 同构：600ms 节流写库+SSE 400ms 轮询+minChars=600 过短重试 3 次——**stubJournalText 最短 652 字必须 >600**，桩短了桩模式必失败）。photo:N 占位三端一致：前端 mdWithPhotos 换 `<img src=…?token=>`、PDF extraImages['photo:'+sort]=Buffer、PNG journalPng.js 按 sort 换 URL——照片删了退化为 alt 文字不炸。莫兰迪 5 套配色双端常量（web/src/journalPalettes.js ⇄ pdfService.PALETTES 同值，改要两边同步）；pdfService.renderJournalPdf 独立实现不动 renderGuidePdf（12 条 check 依赖）；long 模式两遍渲染（14400pt 量高页测 y→真页，PDF 页高上限）；A4=分页+页脚含配色名。PNG 长图在**浏览器 canvas**（journalPng.js 两遍：先量高再画，32k px 上限超了明确报错）。游记权限并入 'guides' page（auth.js pageForPath 前缀 /journals|/journal）；can_use_ai 闸三个 AI 动作（配文/标题/生成），草稿与手写登录即可；他人 404 同攻略。游客模式：router 守卫放行 login/share/home，HomeView 右上角登录/退出、游客不拉 /cities 联想、goPlan/goJournal 拦截去登录页；**首页 .searchbar .go 是绝对定位 right:6px——加第二个按钮必须给 right 偏移（.journal-go right:110px），否则两按钮叠死（v1.8.0 render 抓出的真 bug）**。

## 发版收尾清单

1. 两个自检全绿（check 181/181 或 --online 185/185；render 89/89——render 前先停 9610 上的一切服务，它要独占端口自起桩服务器；render 会往真实 data/ 写一篇测试游记+照片，脚本末尾有清理，没清掉就手工删 journals 表最后一行 + data/journal_photos/<id>/）
2. 改了前端 → rebuild，确认 dist/.latest 指向新目录
3. README 截图用 render-alleyu.mjs 重新生成（img/ 文件名=页面名）
4. 提交推送双远程：github `git@github.com:in1912/Alleyu.git` + gitea `https://gitea.in1912.cc/in1912/Alleyu.git`，push 后 ls-remote 核对
5. 临时文件清理：boot.log、login.json、_spec_extract.txt 等不入库（后两者已在 .gitignore）
