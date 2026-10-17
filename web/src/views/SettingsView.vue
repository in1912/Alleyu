<template>
  <div>
    <h2 style="margin: 0 0 14px">⚙️ 设置</h2>
    <div class="tabs">
      <div class="t" :class="{ on: tab === 'global' }" @click="tab = 'global'">AI 全局配置</div>
      <div class="t" :class="{ on: tab === 'invite' }" @click="tab = 'invite'">邀请码</div>
      <div class="t" :class="{ on: tab === 'upgrade' }" @click="tab = 'upgrade'">升级</div>
      <div class="t" :class="{ on: tab === 'sys' }" @click="tab = 'sys'">系统</div>
      <div class="t" :class="{ on: tab === 'wiki' }" @click="tab = 'wiki'">维基与补全</div>
    </div>

    <!-- AI 全局（admin，v1.6.0 起全站唯一一份 Key）。v1.10.0：本页整页仅管理员可达 -->
    <div v-if="tab === 'global'" class="card">
      <p class="hint" style="margin-top: 0">
        全站共用这一份 AI Key（v1.6.0 起个人配置已下线）：开通「允许使用 AI」的用户都用它生成攻略。
        兼容 OpenAI 接口格式（/v1/chat/completions），填基地址即可，例如 https://api.xxx.com 或 https://api.xxx.com/v1。
        生成请求已默认关闭思考链（推理模型把 token 预算吃进思考会导致正文极短或为空）。
      </p>
      <div class="grid2">
        <div><label class="fld">接口地址</label><input v-model="g.baseUrl" class="input" placeholder="https://api.example.com/v1" /></div>
        <div><label class="fld">模型名</label><input v-model="g.model" class="input" /></div>
        <div style="grid-column: 1 / -1">
          <label class="fld">API Key{{ g.has_key ? '（已保存，留空不修改）' : '' }}</label>
          <input v-model="g.key" type="password" class="input" autocomplete="new-password" />
          <p v-if="g.key && !/^sk-/.test(g.key.trim())" class="hint" style="margin: 4px 0 0">⚠️ 多数服务商 Key 以 sk- 开头——当前输入不是，检查是否粘贴完整（丢前缀会报 401 且报错里看不出差别）</p>
        </div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" @click="saveG">保存全局配置</button>
        <button class="btn ghost" @click="testG">测试连通</button>
        <span v-if="gMsg" :class="gOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ gMsg }}</span>
      </div>
      <div v-if="testModels && testModels.length" class="hint" style="margin-top: 8px">
        服务商可用模型（前 20）：{{ testModels.slice(0, 20).join('、') }}
      </div>
      <hr style="border: none; border-top: 1px solid var(--line); margin: 20px 0" />
      <div class="grid2">
        <div>
          <label class="fld">高德 Web 服务 Key{{ g.amapSet ? '（已配置）' : '' }}</label>
          <input v-model="g.amapKey" class="input" placeholder="32 位十六进制（留空可测已保存的）" />
        </div>
        <div style="align-self: end; display: flex; gap: 8px; flex-wrap: wrap">
          <button class="btn ghost" @click="saveAmap">保存</button>
          <button class="btn ghost" @click="testAmap">测试连通</button>
          <button class="btn ghost" @click="resetAmap">清空</button>
        </div>
      </div>
      <p v-if="amapMsg" :class="amapOk ? 'ok-text' : 'err-text'" style="margin: 8px 0 0; font-size: 13px">
        {{ amapMsg }}
      </p>
      <p class="hint">注意：必须是「Web服务」类型的 Key，「Web端(JS API)」类型调不了 REST 接口（会报 10009）。测试连通会给出具体原因。</p>
      <p class="hint">用户级授权与生成次数在「用户管理」里按人设置。</p>
    </div>

    <!-- 邀请码（v1.10.0）：注册的唯一入口凭证。可设使用次数、可备注、可一次性、可停用 -->
    <div v-if="tab === 'invite'" class="card">
      <p class="hint" style="margin-top: 0">
        注册必须凭邀请码。可生成一次性码（使用次数 1）或多人共用的码；
        已用过的码建议「停用」而不是删除（保留谁邀请了谁的线索）；库里没有任何可用码时，
        注册页会直接显示「当前未开放注册」。
      </p>
      <div class="grid3">
        <div><label class="fld">生成个数</label><input v-model.number="ng.count" type="number" min="1" max="50" class="input" /></div>
        <div><label class="fld">每个可用次数</label><input v-model.number="ng.maxUses" type="number" min="1" max="9999" class="input" /></div>
        <div><label class="fld">备注（谁用/用途）</label><input v-model="ng.note" class="input" placeholder="例如：给老王 / 部门同事" /></div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" :disabled="ngBusy" @click="makeInvites">{{ ngBusy ? '生成中…' : '生成邀请码' }}</button>
        <button class="btn ghost" @click="ng.maxUses = 1">一次性码</button>
        <span v-if="ngMsg" :class="ngOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ ngMsg }}</span>
      </div>

      <table class="tb" style="margin-top: 16px">
        <thead><tr><th>邀请码</th><th>使用次数</th><th>已用</th><th>备注</th><th>状态</th><th>生成时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in invites" :key="c.id">
            <td>
              <b style="letter-spacing: 1px">{{ c.code }}</b>
              <button class="btn ghost sm" style="margin-left: 6px" @click="copy(c.code)">复制</button>
            </td>
            <td>{{ c.max_uses === 1 ? '一次性' : c.max_uses + ' 次' }}</td>
            <td>{{ c.used_count }} / {{ c.max_uses }}</td>
            <td class="hint">{{ c.note || '—' }}</td>
            <td>
              <span class="badge" :class="c.enabled && c.used_count < c.max_uses ? 'blue' : 'gray'">
                {{ !c.enabled ? '已停用' : (c.used_count >= c.max_uses ? '已用完' : '可用') }}
              </span>
            </td>
            <td class="hint">{{ c.created_at }}</td>
            <td>
              <button class="btn ghost sm" @click="toggleInvite(c)">{{ c.enabled ? '停用' : '启用' }}</button>
              <button class="btn ghost sm" style="margin-left: 6px" @click="delInvite(c)">删除</button>
            </td>
          </tr>
          <tr v-if="!invites.length"><td colspan="7" class="hint">还没有邀请码 —— 生成一个才能让别人注册</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 在线升级（v1.11.0，admin）：上传升级包 → 预检 → 应用 → 自动重启 -->
    <div v-if="tab === 'upgrade'" class="card">
      <h3 style="margin-top: 0">在线升级</h3>
      <p class="hint" style="margin-top: 0">
        上传开发机上用 <code>npm run pack:upgrade</code> 打出的 <code>游巷-x.y.z-upgrade.zip</code>。
        先「预检」看它要动哪些文件（<b>预检只读，一个字节都不写</b>），确认无误再「应用升级并重启」。
        应用后服务会<b>自己重启</b>，1~3 秒内页面打不开属于正常，本页会自动等它起来。
      </p>

      <table class="tb" style="max-width: 640px" v-if="st">
        <tbody>
          <tr>
            <td>正在运行</td>
            <td>
              <b>v{{ st.current_version }}</b>
              <span class="hint">（磁盘 package.json：v{{ st.package_json_version }}<template v-if="st.current_version !== st.package_json_version">——换过文件但进程还没重启</template>）</span>
            </td>
          </tr>
          <tr><td>Node / 平台</td><td>{{ st.node }}（{{ st.platform }}）</td></tr>
          <tr><td>现役前端目录</td><td>{{ st.latest_dist || '—' }}<span class="hint">（保留 {{ st.keep.dist }} 份 / 备份保留 {{ st.keep.backups }} 份）</span></td></tr>
          <tr><td>升级目录</td><td class="hint">{{ st.upgrade_root }}</td></tr>
          <tr><td>上传上限</td><td>{{ st.max_upload_mb }} MB<span class="hint">（nginx 的 client_max_body_size 要不小于它）</span></td></tr>
          <tr>
            <td>正在生成</td>
            <td>
              <span v-if="!st.active_generations.length" class="hint">无 —— 现在重启不会打断任何人的生成</span>
              <span v-else class="err-text">
                有 {{ st.active_generations.length }} 个任务在跑（{{ st.active_generations.map((a) => (a.kind === 'guide' ? '攻略' : '游记') + ' #' + a.id).join('、') }}），
                升级会重启服务把它掐断 —— 先等它跑完
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center; flex-wrap: wrap">
        <input ref="upFileEl" type="file" accept=".zip,application/zip" @change="pickPack" />
        <button class="btn ghost" :disabled="!upFile || upBusy || upWaiting" @click="doPlanPack">{{ upPlanning ? '预检中…' : '预检（不改盘）' }}</button>
        <button class="btn" :disabled="!planToken || upBusy || upWaiting" @click="doApplyPack">{{ upApplying ? '升级中…' : '应用升级并重启' }}</button>
        <span v-if="upMsg" class="up-msg" :class="upOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ upMsg }}</span>
      </div>
      <p class="hint" style="margin: 6px 0 0">
        「应用」按钮必须先预检通过才会亮（预检结果保留 10 分钟、只能用一次；预检的是哪个包，应用的就是哪个包）。
      </p>

      <!-- 预检结果 -->
      <div v-if="plan" style="margin-top: 16px">
        <h3 style="margin: 0 0 8px">预检结果：v{{ plan.version.current }} → v{{ plan.version.incoming }}</h3>
        <table class="tb" style="max-width: 640px">
          <tbody>
            <tr><td>文件</td><td>共 {{ plan.summary.files_total }} 个：新增 <b>{{ plan.summary.add }}</b>、覆盖 <b>{{ plan.summary.overwrite }}</b>、无需写入 {{ plan.summary.skip }}</td></tr>
            <tr><td>前端目录</td><td>{{ plan.summary.dist_current || '—' }} → <b>{{ plan.summary.dist_dir || '（本包不含前端）' }}</b></td></tr>
            <tr><td>包大小</td><td>{{ (plan.summary.bytes_zip / 1024).toFixed(0) }} KB（解开 {{ (plan.summary.bytes_uncomp / 1024).toFixed(0) }} KB）</td></tr>
            <tr><td>需要重启</td><td>{{ plan.restart_required ? '是（改动含 server 代码或 package.json）' : '否（只换了前端，下一次请求就生效）' }}</td></tr>
            <tr v-if="plan.version.downgrade"><td>⚠️ 降级</td><td class="err-text">包内版本比现役低 —— 只有在明确回滚时才继续</td></tr>
          </tbody>
        </table>
        <p class="hint" style="margin: 8px 0 0">本次预检没有写入任何文件。逐文件明细：</p>
        <details style="margin-top: 4px">
          <summary class="hint" style="cursor: pointer">展开 {{ plan.files.length }} 个文件</summary>
          <table class="tb" style="margin-top: 8px">
            <thead><tr><th>动作</th><th>路径</th><th>大小</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="f in plan.files" :key="f.path">
                <td>
                  <span class="badge" :class="f.action === 'add' ? 'blue' : (f.action === 'overwrite' ? 'gray' : 'gray')">
                    {{ f.action === 'add' ? '新增' : (f.action === 'overwrite' ? '覆盖' : '跳过') }}
                  </span>
                </td>
                <td><code>{{ f.path }}</code></td>
                <td class="hint">{{ (f.size / 1024).toFixed(1) }} KB</td>
                <td class="hint">{{ f.note || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </details>
        <div v-if="plan.warnings.length" style="margin-top: 10px">
          <p v-for="(w, i) in plan.warnings" :key="i" class="warn-text" style="margin: 4px 0; font-size: 13px">⚠️ {{ w }}</p>
        </div>
      </div>

      <!-- 重启等待 -->
      <div v-if="upWaiting" style="margin-top: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
        <b>🔄 已等 {{ upWaitSec }} 秒，正在等服务重启…</b>
        <p class="hint" style="margin: 6px 0 0">
          服务重启起来的瞬间本页会自动刷新。超过 90 秒还没回来，就看服务器上的
          <code>Logs\restart-child.log</code>（里面写着接管结果和备份目录）。
        </p>
      </div>

      <!-- 升级结果 -->
      <div v-if="upResult" style="margin-top: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 8px">
        <b>升级已落盘：v{{ upResult.version.from }} → v{{ upResult.version.to }}</b>
        <p class="hint" style="margin: 6px 0 0">
          写入 {{ upResult.files_written.total }} 个文件（覆盖 {{ upResult.files_written.overwrite.length }}、新增 {{ upResult.files_written.add.length }}）；
          <template v-if="upResult.backup_dir">备份在 <code>{{ upResult.backup_dir.split(/[\\/]/).pop() }}</code>，可在下面下载；</template>
          前端目录 <code>{{ upResult.dist_dir || '未变' }}</code>。
        </p>
        <p :class="upResult.restart === 'suppressed' ? 'warn-text' : 'hint'" style="margin: 6px 0 0">{{ upResult.restart_note }}</p>
      </div>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 20px 0" />
      <h3 style="margin-top: 0">升级历史</h3>
      <table class="tb">
        <thead><tr><th>时间</th><th>版本</th><th>文件</th><th>大小</th><th>操作人</th><th>重启</th><th>结果</th><th>备份</th></tr></thead>
        <tbody>
          <tr v-for="l in upLogs" :key="l.id">
            <td class="hint">{{ l.created_at }}</td>
            <td>{{ l.from_version }} → <b>{{ l.to_version }}</b></td>
            <td class="hint">+{{ l.files_added }} / ~{{ l.files_overwritten }}</td>
            <td class="hint">{{ (l.bytes / 1024).toFixed(0) }} KB</td>
            <td class="hint">{{ l.actor }}<template v-if="l.ip"><br />{{ l.ip }}</template></td>
            <td>
              <span class="badge" :class="l.restarted ? 'blue' : 'gray'">{{ l.restart_suppressed ? '已抑制' : (l.restarted ? '已重启' : '未重启') }}</span>
            </td>
            <td>
              <span class="badge" :class="l.ok ? 'blue' : 'gray'">{{ l.ok ? '成功' : '失败' }}</span>
              <span v-if="l.note" class="hint" style="display: block; font-size: 12px">{{ l.note }}</span>
            </td>
            <td><button v-if="l.backup_dir" class="btn ghost sm" @click="dlBackup(l.backup_dir)">下载</button><span v-else class="hint">—</span></td>
          </tr>
          <tr v-if="!upLogs.length"><td colspan="8" class="hint">还没有升级记录</td></tr>
        </tbody>
      </table>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 20px 0" />
      <h3 style="margin-top: 0">保留份数</h3>
      <div class="grid2" style="max-width: 520px">
        <div><label class="fld">备份保留（1~20，默认 5）</label><input v-model="k.backups" class="input" placeholder="留空 = 默认 5" /></div>
        <div><label class="fld">旧前端目录保留（1~20，默认 2）</label><input v-model="k.dist" class="input" placeholder="留空 = 默认 2" /></div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 12px; align-items: center">
        <button class="btn ghost" @click="saveKeep">保存保留份数</button>
        <span v-if="kMsg" :class="kOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ kMsg }}</span>
      </div>

      <p class="hint" style="margin-bottom: 0">
        <b>回滚三步</b>：① 在「升级历史」里下载对应的备份 zip（或到服务器 <code>data\upgrades\</code> 里找 <code>backup_&lt;时间戳&gt;</code>）；
        ② 把里面的文件按相同相对路径拷回仓库；③ 重启服务。
        <br /><b>这套升级不会做的事</b>：不删 server 里被废弃的旧文件、不装 npm 依赖、不校验你从哪个版本升（只校验「是不是游巷的包」和「包内版本号与 manifest 是否一致」）。
      </p>
    </div>

    <!-- 系统：版本信息 + 系统默认生成次数 -->
    <div v-if="tab === 'sys'" class="card">
      <table class="tb" style="max-width: 520px" v-if="sys">
        <tbody>
          <tr><td>名称 / 版本</td><td><b>{{ sys.name }}</b> v{{ sys.version }}</td></tr>
          <tr><td>Node</td><td>{{ sys.node }}（{{ sys.platform }}）</td></tr>
          <tr><td>用户 / 攻略</td><td>{{ sys.users }} / {{ sys.guides }}</td></tr>
          <tr><td>城市 / 景点</td><td>{{ sys.cities }} / {{ sys.attractions }}</td></tr>
          <tr><td>AI 通道</td><td>{{ sys.stub_ai ? 'ALLEYU_AI_STUB=1（未配置 Key 时本地桩兜底，配了 Key 一律走真接口）' : '真实接口' }}</td></tr>
        </tbody>
      </table>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 18px 0" />
      <h3 style="margin-top: 0">系统默认生成次数</h3>
      <p class="hint" style="margin-top: 0">
        新用户、以及把次数设成「跟随默认」的用户按这里的值算。<b>留空 = 不限</b>；
        累计总额、用光为止（不做每月重置）。只有真的生成成功才扣一次，失败/重试不扣。
        单独给某人加次数或设成不限，在「用户管理」里改。
      </p>
      <div class="grid2" style="max-width: 520px">
        <div><label class="fld">攻略次数（留空 = 不限）</label><input v-model="q.guide" class="input" placeholder="例如 3；留空不限" /></div>
        <div><label class="fld">游记次数（留空 = 不限）</label><input v-model="q.journal" class="input" placeholder="例如 3；留空不限" /></div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" @click="saveQuota">保存默认次数</button>
        <span v-if="qMsg" :class="qOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ qMsg }}</span>
      </div>
      <p class="hint" style="margin-bottom: 0">管理员账号不受次数限制，但用量（token）照样统计。</p>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 18px 0" />
      <h3 style="margin-top: 0">公开访问地址（分享链接用）</h3>
      <p class="hint" style="margin-top: 0">
        生成分享链接时用它拼域名，例如 <code>http://alleyu.in1912.cn</code>。
        <b>留空 = 用你当前浏览器地址栏的地址</b>——如果你是拿局域网 IP 或 localhost 打开后台，
        复制出去的链接别人就打不开，这时才需要填这里。填了只影响之后新复制的链接（已有链接是纯 token，不受影响）。
      </p>
      <div style="display: flex; gap: 8px; max-width: 520px; align-items: end">
        <div style="flex: 1">
          <label class="fld">公开访问地址</label>
          <input v-model="s.publicBase" class="input" placeholder="留空 = 跟随当前地址；例如 http://alleyu.in1912.cn" />
        </div>
        <button class="btn" @click="saveSys">保存</button>
      </div>
      <p v-if="sMsg" :class="sOk ? 'ok-text' : 'err-text'" style="margin: 8px 0 0; font-size: 13px">{{ sMsg }}</p>
    </div>

    <!-- 维基与补全（v1.12.0）：两家各一个开关，默认都关；关着就一个请求都不发 -->
    <div v-if="tab === 'wiki'" class="card">
      <h3 style="margin-top: 0">维基介绍来源</h3>
      <p class="hint" style="margin-top: 0">
        景点介绍来自维基。两家<b>默认都关闭</b>；<b>未勾选的站点不会发起任何请求</b>（这就是「去掉维基百科连接」的实现）。
        境内多数网络直连维基会超时——先点「测试连接」确认通不通，再决定要不要勾。
        勾选后，单条「补介绍」和「一键补全」才会去抓。
      </p>

      <div class="wiki-row">
        <label class="chk">
          <input type="checkbox" v-model="w.voyage" />
          <span>维基旅行（zh.wikivoyage.org）</span>
        </label>
        <button class="btn ghost sm" :disabled="wProbe.voyage.busy" @click="probeWiki('voyage')">{{ wProbe.voyage.busy ? '测试中…' : '测试连接' }}</button>
        <span v-if="wProbe.voyage.text" :class="wProbe.voyage.ok ? 'ok-text' : 'err-text'">{{ wProbe.voyage.text }}</span>
      </div>

      <div class="wiki-row">
        <label class="chk">
          <input type="checkbox" v-model="w.pedia" />
          <span>维基百科（zh.wikipedia.org）</span>
        </label>
        <button class="btn ghost sm" :disabled="wProbe.pedia.busy" @click="probeWiki('pedia')">{{ wProbe.pedia.busy ? '测试中…' : '测试连接' }}</button>
        <span v-if="wProbe.pedia.text" :class="wProbe.pedia.ok ? 'ok-text' : 'err-text'">{{ wProbe.pedia.text }}</span>
      </div>

      <p class="hint" style="margin: 6px 0 0">
        两家都关时，「补介绍 / 一键补全」会如实告诉你「维基介绍未开启」，只导入高德景点，不会假装抓到介绍。
      </p>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 20px 0" />
      <h3 style="margin-top: 0">批量补全的城市筛选</h3>
      <p class="hint" style="margin-top: 0">
        「补全全部缺景点城市」原来只处理一个景点都没有的城市；现在改成<b>景点数少于 N</b> 的城市也参与
        （严格的「少于」：N=6 时 0~5 条的城市会被选中，正好 6 条的不选）。已有景点的一律跳过、不重复拉高德。
      </p>
      <div style="display: flex; gap: 10px; align-items: end; max-width: 420px">
        <div style="flex: 1">
          <label class="fld">景点数少于 N 的城市也参与补全（0~100）</label>
          <input v-model="w.maxAttrs" class="input" inputmode="numeric" placeholder="留空 = 默认 6" />
        </div>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center">
        <button class="btn" :disabled="wBusy" @click="saveWiki">{{ wBusy ? '保存中…' : '保存维基设置' }}</button>
        <span v-if="wMsg" :class="wOk ? 'ok-text' : 'err-text'" style="margin: 0">{{ wMsg }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api, probeVersion, token, uploadZip } from '../api/index.js';
import { copyText } from '../clipboard.js';

const tab = ref('global');

const g = reactive({ baseUrl: '', model: '', key: '', has_key: false, amapSet: false, amapKey: '' });
const gMsg = ref(''); const gOk = ref(false);
const amapMsg = ref(''); const amapOk = ref(false);
const testModels = ref([]);
const sys = ref(null);

// 邀请码
const invites = ref([]);
const ng = reactive({ count: 1, maxUses: 1, note: '' });
const ngMsg = ref(''); const ngOk = ref(false); const ngBusy = ref(false);

// 系统默认次数
const q = reactive({ guide: '', journal: '' });
const qMsg = ref(''); const qOk = ref(false);

// 公开访问地址（v1.10.2）：拼分享链接用的域名，留空=跟随当前地址
const s = reactive({ publicBase: '' });
const sMsg = ref(''); const sOk = ref(false);

// 维基分站开关 + 补全阈值（v1.12.0）
const w = reactive({ voyage: false, pedia: false, maxAttrs: '6' });
const wMsg = ref(''); const wOk = ref(false); const wBusy = ref(false);
const wProbe = reactive({
  voyage: { busy: false, text: '', ok: null },
  pedia: { busy: false, text: '', ok: null },
});
async function probeWiki(site) {
  const st2 = wProbe[site];
  st2.busy = true; st2.text = '测试中…'; st2.ok = null;
  try {
    // 探针刻意不看开关：就是要「勾选之前」先测通不通
    const j = await api('/wiki/probe?site=' + site);
    const one = (j.sites || [])[0] || {};
    if (one.ok) {
      st2.ok = true;
      st2.text = `可达（${one.ms != null ? one.ms + 'ms' : '已响应'}）`;
    } else {
      st2.ok = false;
      const why = one.error || '连不上（超时或网络不通）';
      st2.text = j.timeout_ms ? `${why}（单站点超时 ${j.timeout_ms}ms）` : why;
    }
  } catch (e) { st2.ok = false; st2.text = e.message; } finally { st2.busy = false; }
}
async function saveWiki() {
  wMsg.value = '';
  wBusy.value = true;
  try {
    await api('/settings', { method: 'PUT', body: { wiki_voyage_enabled: w.voyage, wiki_pedia_enabled: w.pedia, backfill_max_attrs: w.maxAttrs } });
    wOk.value = true;
    wMsg.value = (w.voyage || w.pedia)
      ? '已保存'
      : '已保存（两家都关闭：补介绍与补全都不会发起任何维基请求）';
  } catch (e) { wOk.value = false; wMsg.value = e.message; } finally { wBusy.value = false; }
}
async function saveSys() {
  sMsg.value = '';
  try {
    await api('/settings', { method: 'PUT', body: { public_base_url: s.publicBase } });
    sOk.value = true;
    sMsg.value = '已保存（之后新复制的分享链接生效）';
  } catch (e) { sOk.value = false; sMsg.value = e.message; }
}

async function loadInvites() {
  const j = await api('/invites');
  invites.value = j.invites || [];
}
async function makeInvites() {
  ngMsg.value = '';
  ngBusy.value = true;
  try {
    const j = await api('/invites', { method: 'POST', body: { count: ng.count, max_uses: ng.maxUses, note: ng.note } });
    ngOk.value = true;
    ngMsg.value = `已生成 ${j.codes.length} 个：${j.codes.join('、')}`;
    ng.note = '';
    await loadInvites();
  } catch (e) { ngOk.value = false; ngMsg.value = e.message; } finally { ngBusy.value = false; }
}
async function toggleInvite(c) {
  try {
    await api(`/invites/${c.id}`, { method: 'PUT', body: { enabled: !c.enabled } });
    await loadInvites();
  } catch (e) { alert(e.message); }
}
async function delInvite(c) {
  if (!confirm(`删除邀请码 ${c.code}？${c.used_count > 0 ? '（已被用过，建议改用「停用」保留线索）' : ''}`)) return;
  try {
    await api(`/invites/${c.id}`, { method: 'DELETE' });
    await loadInvites();
  } catch (e) { alert(e.message); }
}
function copy(code) {
  copyText(code).then(
    () => { ngOk.value = true; ngMsg.value = `已复制 ${code}`; },
    (e) => { ngOk.value = false; ngMsg.value = e.message; },
  );
}
async function saveQuota() {
  qMsg.value = '';
  try {
    await api('/settings', { method: 'PUT', body: { quota_default_guide: q.guide, quota_default_journal: q.journal } });
    qOk.value = true; qMsg.value = '已保存（对新用户与「跟随默认」的用户立即生效）';
  } catch (e) { qOk.value = false; qMsg.value = e.message; }
}

async function testG() {
  gMsg.value = ''; testModels.value = [];
  try {
    const body = { base_url: g.baseUrl, model: g.model };
    if (g.key) body.key = g.key;
    const j = await api('/ai/global/test', { method: 'POST', body });
    gOk.value = true; gMsg.value = '✅ 连通成功';
    testModels.value = j.models || [];
  } catch (e) {
    gOk.value = false; gMsg.value = e.message;
  }
}
async function saveG() {
  gMsg.value = '';
  try {
    await api('/ai/global', { method: 'PUT', body: { base_url: g.baseUrl, model: g.model, key: g.key } });
    g.has_key = !!(g.key || g.has_key);
    g.key = '';
    gOk.value = true; gMsg.value = '已保存';
  } catch (e) { gOk.value = false; gMsg.value = e.message; }
}
async function saveAmap() {
  try {
    await api('/settings', { method: 'PUT', body: { amap_key: g.amapKey } });
    g.amapSet = !!g.amapKey;
    amapOk.value = true; amapMsg.value = '高德 Key 已保存';
  } catch (e) { amapOk.value = false; amapMsg.value = e.message; }
}
async function testAmap() {
  amapMsg.value = '测试中…'; amapOk.value = false;
  try {
    const j = await api('/settings/amap/test', { method: 'POST', body: { key: g.amapKey } });
    if (j.ok) { amapOk.value = true; amapMsg.value = '✅ 高德连通正常'; }
    else amapMsg.value = `❌ ${j.info}${j.infocode ? `（${j.infocode}）` : ''}${j.hint ? '——' + j.hint : ''}`;
  } catch (e) { amapMsg.value = e.message; }
}
async function resetAmap() {
  if (!confirm('清空已保存的高德 Key？（之后需要重新配置才能用地图功能）')) return;
  try {
    await api('/settings/amap/reset', { method: 'POST' });
    g.amapSet = false; g.amapKey = '';
    amapOk.value = true; amapMsg.value = '高德 Key 已清空，请到 lbs.amap.com 申请自己的 Key 后在上方填入';
  } catch (e) { amapOk.value = false; amapMsg.value = e.message; }
}

// ---- 在线升级（v1.11.0） ----
const st = ref(null);
const upFileEl = ref(null);
const upFile = ref(null);
const upMsg = ref(''); const upOk = ref(false);
const upBusy = ref(false); const upPlanning = ref(false); const upApplying = ref(false);
const plan = ref(null); const planToken = ref('');
const upResult = ref(null);
const upWaiting = ref(false); const upWaitSec = ref(0);
const upLogs = ref([]);
const k = reactive({ backups: '', dist: '' });
const kMsg = ref(''); const kOk = ref(false);

async function loadUpgrade() {
  st.value = await api('/upgrade/status');
  upLogs.value = st.value.logs || [];
  k.backups = st.value.keep && st.value.keep.backups_set ? String(st.value.keep.backups) : '';
  k.dist = st.value.keep && st.value.keep.dist_set ? String(st.value.keep.dist) : '';
}
async function saveKeep() {
  kMsg.value = '';
  try {
    await api('/settings', { method: 'PUT', body: { upgrade_keep_backups: k.backups, upgrade_keep_dist: k.dist } });
    kOk.value = true; kMsg.value = '已保存（下次升级起生效）';
    await loadUpgrade();
  } catch (e) { kOk.value = false; kMsg.value = e.message; }
}
function pickPack(e) {
  upFile.value = (e.target.files && e.target.files[0]) || null;
  plan.value = null; planToken.value = ''; upResult.value = null;
  upMsg.value = ''; upOk.value = false;
  const mb = (st.value && st.value.max_upload_mb) || 64;
  // 前端的 64MB 是**人话拦截**，真正的上限在 nginx 与服务端（两边都要够大）
  if (upFile.value && upFile.value.size > mb * 1024 * 1024) {
    upOk.value = false;
    upMsg.value = `这个包 ${(upFile.value.size / 1048576).toFixed(1)}MB 超过了服务器上限 ${mb}MB —— 先调大 nginx 的 client_max_body_size 和服务端的 ALLEYU_UPGRADE_MAX_MB`;
  }
}
async function doPlanPack() {
  if (!upFile.value || upBusy.value) return;
  upBusy.value = true; upPlanning.value = true; upMsg.value = ''; plan.value = null; planToken.value = ''; upResult.value = null;
  try {
    const j = await uploadZip('/upgrade/plan', upFile.value);
    plan.value = j.plan; planToken.value = j.token;
    upOk.value = true;
    upMsg.value = `预检通过：可升级到 v${j.plan.version.incoming}（没有写入任何文件）`;
  } catch (e) {
    upOk.value = false; upMsg.value = e.message;
  } finally { upBusy.value = false; upPlanning.value = false; }
}
async function doApplyPack() {
  if (!planToken.value || upBusy.value) return;
  const p = plan.value;
  let ask = `确认应用这个升级包？\n\n${p.version.current} → ${p.version.incoming}\n`
    + `新增 ${p.summary.add} / 覆盖 ${p.summary.overwrite} 个文件\n`
    + (p.restart_required ? '\n应用后服务会自动重启，期间页面打不开（1~3 秒）。' : '\n本包只换前端，不需要重启。');
  if (!confirm(ask)) return;
  if (p.summary.dep_changed
    && !confirm('⚠️ 这个包改了 npm 依赖。如果服务器上还没跑过 npm install --omit=dev，重启后服务会起不来。\n\n仍然继续？')) return;
  upBusy.value = true; upApplying.value = true; upMsg.value = '';
  try {
    // 这里可以用 api()：重启发生在**响应发完之后**（服务端在 res 'finish' 里才拉起接替进程），
    // 所以这次请求本身不会撞上重启窗口。
    upResult.value = await api('/upgrade/apply', { method: 'POST', body: { token: planToken.value, allow_dep_change: !!p.summary.dep_changed } });
    planToken.value = ''; plan.value = null;
    upOk.value = true;
    upMsg.value = upResult.value.restart === 'scheduled' ? '升级已落盘，正在等服务重启…' : '升级已落盘';
    upFile.value = null;
    if (upFileEl.value) upFileEl.value.value = '';
    if (upResult.value.restart === 'scheduled') waitRestart(upResult.value.version.to);
    else await loadUpgrade();
  } catch (e) {
    upOk.value = false; upMsg.value = e.message;
    try { await loadUpgrade(); } catch { /* 状态刷新失败不覆盖上面的错误信息 */ }
  } finally { upBusy.value = false; upApplying.value = false; }
}
// 等服务重启：必须用裸探针（probeVersion 直接 fetch /api/system-info）。
// 这个窗口里 api() 很可能 401，而它的 401 分支会强制跳登录页 —— 那会把管理员踢出去。
async function waitRestart(expect) {
  upWaiting.value = true; upWaitSec.value = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    upWaitSec.value = Math.round((i + 1) * 1.5);
    const info = await probeVersion();
    if (info && info.version === expect) { location.reload(); return; }
  }
  upWaiting.value = false;
  upOk.value = false;
  upMsg.value = '等了 90 秒还没等到新版本上线。到服务器上看 Logs\\restart-child.log（接管结果与备份目录都在里面），或手动重启服务；'
    + '若 server 代码没起来，用「升级历史」里刚下载的备份按要求拷回仓库再重启。';
}
async function dlBackup(name) {
  try {
    const t = token();
    const res = await fetch(`/api/upgrade/backup/${encodeURIComponent(name)}/download`, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { alert('下载备份失败：' + e.message); }
}

onMounted(async () => {
  const gc = await api('/ai/global');
  g.baseUrl = gc.base_url; g.model = gc.model; g.has_key = gc.has_key;
  const stt = await api('/settings');
  g.amapSet = !!stt.amap_key_set;
  q.guide = stt.quota_default_guide || '';
  q.journal = stt.quota_default_journal || '';
  s.publicBase = stt.public_base_url || '';
  w.voyage = stt.wiki_voyage_enabled === true;
  w.pedia = stt.wiki_pedia_enabled === true;
  w.maxAttrs = stt.backfill_max_attrs === undefined || stt.backfill_max_attrs === null ? '6' : String(stt.backfill_max_attrs);
  sys.value = await api('/system-info');
  await loadInvites();
  await loadUpgrade();
});
</script>

<style scoped>
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 12px; }
@media (max-width: 760px) { .grid3 { grid-template-columns: 1fr; } }
.wiki-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.chk { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; min-width: 260px; }
.chk input { width: 16px; height: 16px; accent-color: var(--acc-d); }
</style>
