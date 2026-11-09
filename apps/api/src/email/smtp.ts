import {
  createTransport,
  type SendMailOptions,
  type SentMessageInfo,
} from 'nodemailer';
import { z } from 'zod';

export class SmtpConfigError extends Error {
  constructor() {
    super(
      'SMTP 配置无效，请检查 SMTP_HOST、SMTP_PORT、SMTP_SECURE、SMTP_USER、SMTP_PASSWORD 和 SMTP_FROM。',
    );
    this.name = 'SmtpConfigError';
  }
}

/** 不携带供应商原始异常或 cause，避免泄露凭据、收件人或验证码。 */
export class EmailDeliveryError extends Error {
  constructor() {
    super('邮件服务暂时不可用，请稍后重试。');
    this.name = 'EmailDeliveryError';
  }
}

export class EmailInputError extends Error {
  constructor() {
    super('邮件参数无效。');
    this.name = 'EmailInputError';
  }
}

const smtpEnvironmentSchema = z.object({
  SMTP_HOST: z
    .string()
    .trim()
    .pipe(z.union([z.hostname(), z.ipv4(), z.ipv6()])),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535),
  SMTP_SECURE: z.enum(['true', 'false']),
  SMTP_USER: z.string().trim().min(1),
  // 密码保留原值，不截掉可能属于凭据的空格。
  SMTP_PASSWORD: z.string().refine((value) => value.trim().length > 0),
  SMTP_FROM: z.string().trim().pipe(z.email()),
});

export interface SmtpConfig {
  host: string;
  port: number;
  /** true 为连接时立即使用 TLS；false 为强制 STARTTLS。 */
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

/** 显式读取配置；导入模块、运行测试或数据库检查时不会连接 SMTP。 */
export function readSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig {
  const result = smtpEnvironmentSchema.safeParse(env);
  if (!result.success) throw new SmtpConfigError();
  return {
    host: result.data.SMTP_HOST,
    port: result.data.SMTP_PORT,
    secure: result.data.SMTP_SECURE === 'true',
    user: result.data.SMTP_USER,
    password: result.data.SMTP_PASSWORD,
    from: result.data.SMTP_FROM,
  };
}

const emailSchema = z.object({
  to: z.email(),
  subject: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value)),
  text: z.string().min(1),
  html: z.string().min(1).optional(),
});

export type EmailMessage = z.infer<typeof emailSchema>;

/** 只暴露适配器需要的 Nodemailer 能力，测试可替换为官方内存 transport。 */
export interface MailTransport {
  sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
  verify(): Promise<true>;
  close(): void;
}

/** 创建对象不联网；首次 send/verify 才连接。SMTP 协议和 MIME 交给 Nodemailer。 */
export function createSmtpTransport(config: SmtpConfig) {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: config.user, pass: config.password },
    // 毫秒；限制连接建立与空闲等待，避免注册请求长时间挂起。
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** 仅用于服务端内部调用，不开放任意收件人发送的 HTTP 接口。 */
export function createSmtpMailer(
  config: SmtpConfig,
  transport: MailTransport = createSmtpTransport(config),
) {
  return {
    async send(message: EmailMessage): Promise<{ messageId: string }> {
      const parsed = emailSchema.safeParse(message);
      if (!parsed.success) throw new EmailInputError();
      try {
        const info = await transport.sendMail({
          from: config.from,
          ...parsed.data,
        });
        if (
          info.rejected?.length ||
          (info.accepted && !info.accepted.includes(parsed.data.to))
        ) {
          throw new EmailDeliveryError();
        }
        // 不把原始 SMTP 响应、收件人或邮件正文交给上层作为日志内容。
        return { messageId: info.messageId };
      } catch {
        throw new EmailDeliveryError();
      }
    },
    /** 只检查连接及认证；不能据此声称 From 已获允许或邮件送达。 */
    async verify(): Promise<void> {
      try {
        await transport.verify();
      } catch {
        throw new EmailDeliveryError();
      }
    },
    close(): void {
      transport.close();
    },
  };
}
