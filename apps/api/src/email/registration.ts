import { z } from 'zod';

import { EmailInputError, type EmailMessage } from './smtp.ts';

const inputSchema = z.object({
  to: z.email(),
  otp: z.string().regex(/^\d{6}$/),
});

/**
 * 注册验证码模板。otp 由后续认证库生成；本模块不生成、存储或校验验证码有效性。
 * 展示的 10 分钟有效期必须与认证插件的 600 秒配置一致。
 */
export function registrationEmail(to: string, otp: string): EmailMessage {
  const result = inputSchema.safeParse({ to, otp });
  if (!result.success) throw new EmailInputError();
  const code = result.data.otp;
  return {
    to: result.data.to,
    subject: 'Folinel 注册验证码',
    text: `你的 Folinel 注册验证码是：${code}。验证码在 10 分钟内有效。请勿将验证码告诉他人。如果不是你本人操作，请忽略此邮件。`,
    // 仅插入已限制为六位数字的验证码，不插入用户可控 HTML。
    html: `<p>你的 Folinel 注册验证码是：</p><p><strong>${code}</strong></p><p>验证码在 10 分钟内有效。请勿将验证码告诉他人。</p><p>如果不是你本人操作，请忽略此邮件。</p>`,
  };
}
