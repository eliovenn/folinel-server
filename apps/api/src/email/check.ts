/* eslint-disable no-process-env, no-console */
import { createSmtpMailer, readSmtpConfig, SmtpConfigError } from './smtp.ts';

let mailer: ReturnType<typeof createSmtpMailer> | undefined;
try {
  mailer = createSmtpMailer(readSmtpConfig(process.env));
  await mailer.verify();
  console.info(
    'SMTP 连接及认证检查通过；未发送邮件，发信域名许可及送达仍需单独验证。',
  );
} catch (error: unknown) {
  const message =
    error instanceof SmtpConfigError
      ? error.message
      : '请检查 SMTP 主机、端口、TLS、凭据和网络。';
  console.error(`SMTP 检查失败：${message}`);
  process.exitCode = 1;
} finally {
  mailer?.close();
}
