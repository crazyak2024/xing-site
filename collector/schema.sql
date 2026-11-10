-- 醒 · BI 事件表。刻意不存 IP / User-Agent / cookie：
-- vid 是 sessionStorage 级别的临时 id，关标签页即失效，跨访问拼不出个人档案。
CREATE TABLE IF NOT EXISTS ev (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,   -- found / not_found / gap_wish / search / pick / open
  vid       TEXT,            -- 本次会话的临时匿名 id（关页即失效）
  q         TEXT,            -- 当时的搜索词
  topic     TEXT,
  node      TEXT,
  results   INTEGER,         -- 当时命中几条（0 = 内容缺口）
  lib       INTEGER,         -- 当时库内总条数，用于把比率放回当时的分母
  note      TEXT,            -- 「没找到」那颗按钮后面用户手写的一句话
  item      TEXT,            -- open 事件打开的是哪一条
  client_at TEXT,
  server_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ev_kind_ts ON ev(kind, server_at);
CREATE INDEX IF NOT EXISTS ev_q ON ev(q);

-- rt1（CY 2026-11-07 21:45 批）：实时补搜两速原型的缓存与硬预算闸。
-- 复用同一个 Worker/D1，不新建账号资源——这个功能的风险是"每次真实用户搜索都可能触发付费
-- 调用"，所以 rt_budget 是**服务端强制的硬上限**，不是前端的建议值；闸一旦打满，
-- 直接返回"未搜索"而不是继续花钱，宁可当天提前停，不可超支。
CREATE TABLE IF NOT EXISTS rt_cache (
  q_norm     TEXT PRIMARY KEY,   -- 归一化查询词（trim+lower），同一个问题的N种问法应撞同一行
  results    TEXT NOT NULL,      -- JSON 数组，每条 {platform,title,link,cover,duration_s}
  cost_usd   REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rt_budget (
  day        TEXT PRIMARY KEY,   -- YYYY-MM-DD（UTC，Worker 环境没有本地时区）
  spent_usd  REAL NOT NULL DEFAULT 0
);

-- 缺口车道（CY 2026-11-10 批「把补搜做起来」）：边缘只负责记下"有人要这个"，
-- 本机守护进程出站认领、跑快道/慢道、回写结果。为什么不是边缘直接搜：Quorum 跑在
-- CY 那台 Mac 的 127.0.0.1，Cloudflare 边缘物理上够不到（11-08 实测，不是代码 bug）。
-- q_norm 与 rt_cache 同一把钥匙（trim+lower），两张表天然对齐。
CREATE TABLE IF NOT EXISTS gap_lane (
  q_norm     TEXT PRIMARY KEY,
  q          TEXT NOT NULL,
  state      TEXT NOT NULL,      -- new / working / fast_done / done / skipped / failed
  note       TEXT,               -- 判定理由、花费、慢道进展，给人看的一句话
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gap_lane_state ON gap_lane(state, created_at);
