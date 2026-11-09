-- 首次安装的注册域名策略；后续管理操作可启停或删除，不在启动时重新写入。
INSERT INTO "blocked_email_domain" ("domain") VALUES
  ('outlook.com'), ('hotmail.com'), ('live.com');
