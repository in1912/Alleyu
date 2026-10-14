# CLAUDE.md

本文件给 Claude Code 提供本仓库的作业指引。

## 项目

游巷 Alleyu — 自托管 AI 旅行攻略生成器（Express + node:sqlite + Vue3）。架构完全模仿 D:\cc\personal-workbench（工作台）：同样的 latestDist 静态服务、Bearer+?token= 双通道鉴权、EXEMPT 免登录前缀、allowed_pages 页面白名单。改本项目前若不熟悉这些模式，先看工作台对应实现。

## 常用命令

```bash
npm start                                     # 起 9610（start.bat 同效）；Node >= 22.5（node:sqlite）
ALLEYU_AI_STUB=1 node server/index.js         # 桩 AI 模式（不调外网）
node scripts/check-alleyu.mjs                 # 离线自检 41 项（独立临时 DATA_DIR，端口 9690）
node scripts/check-alleyu.mjs --online        # +4 项真实高德/Open-Meteo 断言
NODE_PATH=D:\cc\personal-workbench\node_modules node scripts/render-alleyu.mjs   # Playwright 渲染自检（先起 9610）
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
- **SSE=查库**：生成写库节流 ~600ms，stream 端点 400ms 轮询推 delta；前端 GuideView 依赖 `streamed` ref（不是 content）。
- **高德 staticmap paths 格式**（实测验证过）：`8,0x3f7d5c,0.9,,:lng,lat;lng,lat` — 冒号在点串前、分号隔点、竖线隔多条线。免费 key 3 QPS → amapService 全局 350ms 串行节流，别拆。
- 照片代理 `/api/amap/photo?u=` 有域名白名单（amap/autonavi/mypeople/gaode 系）。
- 天气走 Open-Meteo 免 key：预报 16 天；历史用 archive 的 monthStats（一次多年调用+客户端同月过滤，sampleDays≥20 才可信）。预警是规则研判，UI 必须带"非官方预警"标注。
- 九模块框架模板在 guideService.js 的 FRAMEWORK 常量（用户原话模板，勿改结构）；提示词里要求 `### Day N｜主题` 标题格式，splitDays 靠它切天。
- 桩语义（v1.1.0 起）：**桩是兜底不是覆盖**——streamChat 只在 `!cfg || cfg.source==='stub'` 时走桩，个人/全局配齐了 Key 一律走真接口。ALLEYU_AI_STUB=1 只剩两个作用：设置页显示标记 + 放行 guideRoutes 的 AI 权限闸门（否则没配 key 时 400）。
- 攻略展示净化（GuideView.cleanMd）：剥旧桩横幅 + 正文只从第一个 markdown 标题开始（AI 废话前言不显示不复制）；存储原文不动。
- 高德 Key 常见错误码人话提示在 settingsRoutes 的 AMAP_HINTS（10009=JS API 类型 Key 调不了 REST，真实踩坑）；`POST /settings/amap/test` 永远回 200+{ok,...}，`POST /settings/amap/reset` 恢复 db.js 的 DEFAULT_AMAP_KEY。
- SPA 挂载坑（App.vue）：登录是 SPA 内跳转，App 只挂载一次 → 必须 watch route.fullPath 补拉 /auth/me，否则从首页进任何功能页侧栏空菜单。渲染自检要用 SPA 流程（登录后不整页 goto），page.goto 会重挂 App 把这类 bug 藏住。
- 首页骑手是乳白兔子（RiderScene.vue，v1.0 的 PigScene.vue 已删）：浅色角色在浅色背景上，手臂用双层描边（#b3a68c 底衬 + #f6f1e5 乳白面层）保对比度。
- guides 严格 user_id 隔离（admin 也读不到他人的，by design）；城市/景点库全局共享。
- 前端 dist 随 git 分发（.gitignore 不忽略 web/dist/），Dockerfile COPY 依赖它；改前端必须 rebuild + commit。

## 发版收尾清单

1. 两个自检全绿（check 41/41 或 --online 45/45；render 20/20）
2. 改了前端 → rebuild，确认 dist/.latest 指向新目录
3. README 截图用 render-alleyu.mjs 重新生成（img/ 文件名=页面名）
4. 提交推送双远程：github `git@github.com:in1912/Alleyu.git` + gitea `https://gitea.in1912.cc/in1912/Alleyu.git`，push 后 ls-remote 核对
5. 临时文件清理：boot.log、login.json、_spec_extract.txt 等不入库（后两者已在 .gitignore）
