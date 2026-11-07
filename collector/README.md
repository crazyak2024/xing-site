# 醒 · BI 收集端点

**状态：代码已就绪，未部署。** 部署需要 Cloudflare 登录态（`wrangler login` 走浏览器
OAuth），这一步只能 CY 本人做；而且在他的 Cloudflare 账号上创建一个公网端点属于
红线动作，不自行执行。

## 为什么用 Cloudflare Worker + D1
- **第一方**：我们自己的代码、自己的域。站上明写「没有第三方脚本」，接 GA 那类东西
  等于当场作废那句话。
- **零成本**：Workers 免费 10 万请求/天、D1 免费 5GB，这个站用不到千分之一。
- **已有账号**：`vectorherd.com` 整域已托在 Cloudflare（NS = tom/elma.ns.cloudflare.com，
  notes 子域走 Zero Trust tunnel），不需要新买域名或开新账号。

## 部署
```
npm i -g wrangler && wrangler login
cd site/collector
wrangler d1 create xing-bi            # 把返回的 database_id 填进 wrangler.toml
wrangler d1 execute xing-bi --remote --file=schema.sql
wrangler deploy                        # 得到 https://xing-bi.<账号>.workers.dev
```
然后把那个地址填进 `site/app.js` 顶部的 `COLLECT_URL`，推一次即生效。
在那之前，事件只排在用户自己浏览器的本地队列里，**一个请求都不会发出去**；
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
