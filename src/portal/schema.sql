-- 服务入口注册表（aio-portal CLI 与 tunnel 控制台共用同一张表）
CREATE SCHEMA IF NOT EXISTS portal;
CREATE TABLE IF NOT EXISTS portal.service (
  alias      text PRIMARY KEY CHECK (alias ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
COMMENT ON TABLE portal.service IS '服务入口注册表：182 内网 localmesh 与外部 home-edge 共用同一条记录';
