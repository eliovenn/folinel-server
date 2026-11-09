-- 官方镜像仅在空数据卷初始化时执行。应用角色拥有业务库，但不是超级用户。
\getenv app_password APP_DB_PASSWORD
CREATE ROLE folinel LOGIN PASSWORD :'app_password';
CREATE DATABASE folinel OWNER folinel;
