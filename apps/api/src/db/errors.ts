import { DatabaseConfigError } from './config.ts';

const messages: Record<string, string> = {
  '28P01': '数据库认证失败，请检查用户名和数据库密码。',
  '28000': '数据库拒绝认证，请检查用户和访问权限。',
  '3D000': '指定的数据库不存在，请检查连接串中的数据库名。',
  '53300': '数据库连接数已满，请检查连接池大小和现有连接。',
  ECONNREFUSED: '数据库拒绝连接，请检查主机、端口和 PostgreSQL 服务。',
  ENOTFOUND: '无法解析数据库主机，请检查连接地址和 DNS。',
  EAI_AGAIN: '数据库主机 DNS 解析暂时失败，请稍后重试。',
  ENETUNREACH: '无法到达数据库网络；Supabase 可尝试 Session pooler 地址。',
  ETIMEDOUT: '数据库连接超时，请检查网络和防火墙。',
  CONNECT_TIMEOUT: '数据库连接超时，请检查网络和防火墙。',
  DATABASE_CHECK_TIMEOUT:
    '数据库连接检查超过 15 秒仍未完成，请检查代理、DNS 和数据库状态；Supabase Direct connection 可尝试改用 Connect 中的 Session pooler（端口 5432）。超时尚不能判断密码是否正确。',
  CERT_HAS_EXPIRED: '数据库 SSL 证书已过期，请更新证书。',
  DEPTH_ZERO_SELF_SIGNED_CERT:
    '数据库 SSL 证书不受信任，请配置对应的 CA 证书。',
  SELF_SIGNED_CERT_IN_CHAIN: '数据库 SSL 证书不受信任，请配置对应的 CA 证书。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    '无法验证数据库 SSL 证书，请配置对应的 CA 证书。',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    '缺少数据库 SSL 证书的签发者，请配置对应的 CA 证书。',
  ERR_TLS_CERT_ALTNAME_INVALID:
    '数据库 SSL 证书与主机名不匹配，请检查连接地址。',
  EADDRINUSE: 'API 端口已被占用，请关闭占用该端口的进程。',
};

/** 只输出已知错误码对应的提示；驱动异常可能带密码、SQL 或连接地址。 */
export function databaseErrorMessage(error: unknown): string {
  if (error instanceof DatabaseConfigError) return error.message;
  let current = error;
  // Drizzle 可能把驱动异常放在 cause 中，限制深度以避免循环引用。
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') break;
    // Supabase pooler 使用通用 SQLSTATE；同时匹配完整错误特征，避免误判其他内部错误。
    if (
      'code' in current &&
      current.code === 'XX000' &&
      'message' in current &&
      typeof current.message === 'string' &&
      /\btenant\s*\/\s*user\b[^\r\n]*\bnot found\b/i.test(current.message)
    ) {
      return 'Supabase 连接池找不到租户或用户；请从同一个项目的 Connect 面板重新复制完整 Session pooler 连接串，尤其检查 postgres.<项目标识> 用户名。';
    }
    if ('code' in current && typeof current.code === 'string') {
      const message = Object.hasOwn(messages, current.code)
        ? messages[current.code]
        : undefined;
      if (message) return message;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return '数据库操作失败，请检查连接配置、网络和数据库状态；原始错误已隐藏。';
}
