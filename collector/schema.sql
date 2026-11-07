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
