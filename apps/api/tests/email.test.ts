/* eslint-disable no-process-env */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { createTransport, type SentMessageInfo } from 'nodemailer';

import { registrationEmail } from '#src/email/registration.ts';
import {
  createSmtpMailer,
  createSmtpTransport,
  EmailDeliveryError,
  EmailInputError,
  type MailTransport,
  readSmtpConfig,
  SmtpConfigError,
} from '#src/email/smtp.ts';

const environment = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'smtp-user',
  SMTP_PASSWORD: 'smtp-secret',
  SMTP_FROM: 'noreply@whisprea.ink',
};

function fakeTransport(overrides: Partial<MailTransport> = {}): MailTransport {
  return {
    sendMail: () => Promise.reject(new Error('测试不能意外发信。')),
    verify: () => Promise.resolve(true),
    close() {},
    ...overrides,
  };
}

describe('SMTP 环境配置', () => {
  it('支持 Resend 和其他提供商，保留密码原值', () => {
    const config = readSmtpConfig(environment);
    assert.equal(config.port, 587);
    assert.equal(config.secure, false);
    assert.equal(config.from, 'noreply@whisprea.ink');
    const other = readSmtpConfig({
      ...environment,
      SMTP_HOST: 'mail.other.example',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_PASSWORD: ' secret with spaces ',
    });
    assert.equal(other.host, 'mail.other.example');
    assert.equal(other.secure, true);
    assert.equal(other.password, ' secret with spaces ');
  });

  it('拒绝缺失字段、非法端口、布尔值、地址及 URL 主机', () => {
    const invalid: NodeJS.ProcessEnv[] = [
      {},
      ...Object.keys(environment).map((key) => ({ ...environment, [key]: '' })),
      ...['0', '-1', '1.5', '65536', 'abc'].map((SMTP_PORT) => ({
        ...environment,
        SMTP_PORT,
      })),
      { ...environment, SMTP_SECURE: 'yes' },
      { ...environment, SMTP_PASSWORD: '   ' },
      { ...environment, SMTP_HOST: 'smtp://user:TOP_SECRET@example.test' },
      { ...environment, SMTP_FROM: 'a@example.test,b@example.test' },
      { ...environment, SMTP_FROM: 'a@example.test\r\nBcc: b@example.test' },
    ];
    for (const env of invalid) {
      assert.throws(
        () => readSmtpConfig(env),
        (error: unknown) => {
          assert.ok(error instanceof SmtpConfigError);
          assert.doesNotMatch(error.message, /TOP_SECRET|smtp-secret/);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    }
  });

  it('检查命令配置失败时返回非零状态且不泄露凭据', () => {
    const result = spawnSync(process.execPath, ['src/email/check.ts'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ...environment, SMTP_PORT: 'TOP_SECRET' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SMTP 检查失败/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /TOP_SECRET|smtp-secret/,
    );
  });
});

describe('SMTP 传输与错误边界', () => {
  it('两种连接方式都要求 TLS，关闭通信日志并限制连接等待', () => {
    for (const secure of ['true', 'false']) {
      const transport = createSmtpTransport(
        readSmtpConfig({ ...environment, SMTP_SECURE: secure }),
      );
      try {
        assert.equal(transport.options.secure, secure === 'true');
        assert.equal(transport.options.requireTLS, secure === 'false');
        assert.equal(transport.options.tls?.rejectUnauthorized, true);
        assert.equal(transport.options.logger, false);
        assert.equal(transport.options.debug, false);
        assert.ok((transport.options.connectionTimeout ?? Infinity) <= 10_000);
        assert.ok((transport.options.socketTimeout ?? Infinity) <= 15_000);
      } finally {
        transport.close();
      }
    }
  });

  it('用官方 stream transport 组装验证码邮件，只返回投递标识', async () => {
    const stream = createTransport({ streamTransport: true, buffer: true });
    let captured: SentMessageInfo | undefined;
    const transport = fakeTransport({
      async sendMail(options) {
        const info = await stream.sendMail(options);
        captured = info;
        return info;
      },
      close: () => stream.close(),
    });
    const mailer = createSmtpMailer(readSmtpConfig(environment), transport);
    try {
      const receipt = await mailer.send(
        registrationEmail('test@example.com', '123456'),
      );
      assert.deepEqual(Object.keys(receipt), ['messageId']);
      assert.ok(receipt.messageId);
      assert.equal(captured?.envelope.from, 'noreply@whisprea.ink');
      assert.deepEqual(captured?.envelope.to, ['test@example.com']);
      const message: unknown = captured?.message;
      assert.ok(Buffer.isBuffer(message));
      const content = message.toString('utf8');
      assert.match(content, /multipart\/alternative/);
      assert.match(content, /Content-Type: text\/plain/);
      assert.match(content, /Content-Type: text\/html/);
      const encodedBodies = [
        ...content.matchAll(
          /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?=----)/g,
        ),
      ].map((match) => match[1].replaceAll('\r\n', ''));
      assert.equal(encodedBodies.length, 2);
      const decodedBodies = encodedBodies.map((body) =>
        Buffer.from(body, 'base64').toString('utf8'),
      );
      assert.ok(decodedBodies.every((body) => body.includes('123456')));
    } finally {
      mailer.close();
    }
  });

  it('拒绝多个收件人、头注入和无效模板参数，发送前即失败', async () => {
    let sent = false;
    const mailer = createSmtpMailer(
      readSmtpConfig(environment),
      fakeTransport({
        sendMail() {
          sent = true;
          return Promise.reject(new Error('不应发送。'));
        },
      }),
    );
    for (const message of [
      { to: 'a@example.com,b@example.com', subject: '注册', text: '123456' },
      {
        to: 'a@example.com',
        subject: '注册\r\nBcc: b@example.com',
        text: '123456',
      },
    ]) {
      await assert.rejects(mailer.send(message), EmailInputError);
    }
    assert.equal(sent, false);
    for (const code of ['12345', '1234567', '<img>', '123\n45']) {
      assert.throws(
        () => registrationEmail('test@example.com', code),
        EmailInputError,
      );
    }
  });

  it('连接、认证和发送失败都隐藏供应商原文与敏感信息', async () => {
    const secret =
      'password=smtp-secret; recipient=test@example.com; otp=123456';
    const mailer = createSmtpMailer(
      readSmtpConfig(environment),
      fakeTransport({
        sendMail: () => Promise.reject(new Error(secret)),
        verify: () => Promise.reject(new Error(secret)),
      }),
    );
    for (const action of [
      () => mailer.send(registrationEmail('test@example.com', '123456')),
      () => mailer.verify(),
    ]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(error instanceof EmailDeliveryError);
        assert.doesNotMatch(
          error.message,
          /smtp-secret|test@example.com|123456/,
        );
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  it('SMTP 未接收目标地址时不能报告发送成功', async () => {
    const mailer = createSmtpMailer(
      readSmtpConfig(environment),
      fakeTransport({
        sendMail: () =>
          Promise.resolve({
            messageId: 'fake-id',
            envelope: { from: environment.SMTP_FROM, to: ['test@example.com'] },
            accepted: [],
            rejected: ['test@example.com'],
          }),
      }),
    );
    await assert.rejects(
      mailer.send(registrationEmail('test@example.com', '123456')),
      EmailDeliveryError,
    );
  });

  it('连接检查不调用发信，关闭时释放 transport', async () => {
    let checked = 0;
    let closed = 0;
    const mailer = createSmtpMailer(
      readSmtpConfig(environment),
      fakeTransport({
        verify() {
          checked++;
          return Promise.resolve(true);
        },
        close() {
          closed++;
        },
      }),
    );
    await mailer.verify();
    mailer.close();
    assert.equal(checked, 1);
    assert.equal(closed, 1);
  });
});
