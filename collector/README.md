# 醒 · BI 收集端点

**状态：已上线（2026-11-07）。端点 `https://bi.vectorherd.com`，已端到端验过（写入+读回）。**

- Worker `xing-bi` / D1 `xing-bi`（uuid `9f61e002-bda1-4641-a658-44626405c95f`）
- CF account id `13480f1d3136407bc424f6639391a335`
- 前端 `site/app.js` 的 `COLLECT_URL` 已填
- **为什么是自定义域不是 workers.dev**：这个账号还没注册 workers.dev 子域（账号级
  一次性设置，要去 dashboard 点），而 vectorherd.com 整域已在同一账号下，
  `custom_domain = true` 会自动建 DNS 记录，一条命令完事。
- **迁站待办**：CY 2026-11-07 定了以后整体迁 `live.vozo.ai` 时 BI 一起迁。
  `worker.js` 的 `ALLOWED` 里已经预放了 `https://live.vozo.ai`，迁站当天不会撞 CORS。
  要改的只有：wrangler.toml 的 `routes` 和 app.js 的 `COLLECT_URL`。

## 为什么用 Cloudflare Worker + D1
- **第一方**：我们自己的代码、自己的域。站上明写「没有第三方脚本」，接 GA 那类东西
  等于当场作废那句话。
- **零成本**：Workers 免费 10 万请求/天、D1 免费 5GB，这个站用不到千分之一。
- **已有账号**：`vectorherd.com` 整域已托在 Cloudflare（NS = tom/elma.ns.cloudflare.com，
  notes 子域走 Zero Trust tunnel），不需要新买域名或开新账号。

## 部署（4 步，约 3 分钟）

> 下面每条命令的 flag 都在 **wrangler 4.158.0** 上实测过（`--remote` / `--file` / `-y`
> 确实存在）。版本变了先 `npx wrangler d1 execute --help` 核一遍再跑。
> wrangler 会自动使用 shell 里的代理变量（Cloudflare 在墙外，需要 Clash 开着）。

```bash
cd ~/repos/future/xing/site/collector

# 1) 登录（会开浏览器做 OAuth；确认落在持有 vectorherd.com 的那个 Cloudflare 账号上）
npx -y wrangler@4.158.0 login

# 2) 建数据库 —— 输出里有一行 database_id，复制它
npx -y wrangler@4.158.0 d1 create xing-bi

# 3) 把上一步的 database_id 填进 wrangler.toml，然后建表
#    （wrangler.toml 里那行现在是 TODO 占位，不填会报 database not found）
npx -y wrangler@4.158.0 d1 execute xing-bi --remote -y --file=schema.sql

# 4) 部署 —— 输出里有一行 https://xing-bi.<你的子域>.workers.dev
npx -y wrangler@4.158.0 deploy
```

最后把第 4 步输出的那个 URL 发回来（或自己填进 `site/app.js` 顶部的 `COLLECT_URL=""`，
推一次即生效）。在那之前，事件只排在用户自己浏览器的本地队列里，**一个请求都不会发出去**；
端点填上后，积压的队列会随下一个事件一起补发。

## 看数（先用命令行，不必建后台）
```
# 两种离开各多少 —— 这就是成绩单
wrangler d1 execute xing-bi --remote --command \
  "SELECT kind, COUNT(*) FROM ev GROUP BY 1"

# 内容缺口清单：用户搜了、我们一条都没有的词
wrangler d1 execute xing-bi --remote --command \
  "SELECT q, COUNT(*) n FROM ev WHERE kind='search' AND results=0 GROUP BY 1 ORDER BY n DESC LIMIT 30"

# 用户自己写下的「我想找什么」
wrangler d1 execute xing-bi --remote --command \
  "SELECT note, server_at FROM ev WHERE kind='gap_wish' ORDER BY id DESC LIMIT 50"
```

## 匿名口径（改任何一行之前先读这段）
- `vid` 存在 **sessionStorage**，关标签页即失效 —— 够回答「这一次来访他搜了什么、
  点了哪颗按钮」，但**跨访问拼不出一个人的档案**。换成 localStorage 持久 id 就越界了。
- 不落 IP、不落 User-Agent、不发 Set-Cookie。charter 明文禁止观看行为画像，
  而且「不认识你」那行字就挂在用户眼前。
- 事件类型白名单在 worker 里，未知类型直接丢，端点不会变成任意写入口。
