import { z } from 'zod';

export class ProxyConfigError extends Error {
  constructor() {
    super('TRUST_PROXY 配置无效，请填写逗号分隔的可信代理 IP 或 CIDR；直连时留空。');
  }
}

/** 代理链解析交给 Express；只允许显式地址，避免误用 true 或代理跳数。 */
export function readProxyConfig(env: NodeJS.ProcessEnv): string[] {
  const addresses = (env.TRUST_PROXY ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const parsed = z.array(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])).safeParse(addresses);
  if (!parsed.success) throw new ProxyConfigError();
  return parsed.data;
}
