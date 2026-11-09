/* eslint-disable no-process-env */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { createDatabase } from '#src/db/client.ts';
import { DatabaseConfigError, readDatabaseConfig } from '#src/db/config.ts';
import { databaseErrorMessage } from '#src/db/errors.ts';

const localUrl =
  'postgresql://folinel:test%40password@127.0.0.1:5432/folinel_test';

// 仅使用假凭据测试配置与错误边界，不连接开发数据库。
describe('数据库配置', () => {
  it('接受 Supabase Session pooler 和自建 PostgreSQL 地址', () => {
    const remote = readDatabaseConfig({
      DATABASE_URL:
        'postgresql://postgres.project:fake%23pass@pooler.example.com:5432/postgres',
    });
    assert.equal(remote.ssl, true);
    const local = readDatabaseConfig({
      DATABASE_URL: localUrl,
      DATABASE_SSL: 'false',
    });
    assert.equal(local.ssl, false);
    assert.equal(local.url, localUrl);
    const ipv6 = readDatabaseConfig({
      DATABASE_URL: 'postgres://folinel:fake@[::1]:5432/folinel_test',
    });
    assert.ok(ipv6.url.includes('[::1]'));
  });

  it('拒绝缺失或无效连接串，异常不泄露输入', () => {
    for (const url of [
      '',
      'not-a-uri-secret',
      'https://user:secret@example.com/database',
      'postgresql://user:secret@localhost',
      'postgresql://user@localhost/database',
      'postgresql://user:secret@localhost/database#secret',
      'postgresql://user:bad%password@localhost/database',
      'postgresql://user:secret@localhost:0/database',
    ]) {
      assert.throws(
        () => readDatabaseConfig({ DATABASE_URL: url }),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseConfigError);
          assert.doesNotMatch(error.message, /secret|bad%password/);
          return true;
        },
      );
    }
  });

  it('拒绝可能覆盖 SSL、主机和连接池配置的 URI 查询参数', () => {
    for (const suffix of [
      '?sslmode=disable',
      '?host=other.example',
      '?max=200',
    ]) {
      assert.throws(
        () => readDatabaseConfig({ DATABASE_URL: localUrl + suffix }),
        DatabaseConfigError,
      );
    }
  });

  it('拒绝无效 SSL 值、连接数和关闭 SSL 时的证书配置', () => {
    for (const value of ['', 'yes', '0']) {
      assert.throws(
        () =>
          readDatabaseConfig({ DATABASE_URL: localUrl, DATABASE_SSL: value }),
        DatabaseConfigError,
      );
    }
    for (const value of ['', '0', '-1', '1.5', 'abc', '51']) {
      assert.throws(
        () =>
          readDatabaseConfig({
            DATABASE_URL: localUrl,
            DATABASE_POOL_MAX: value,
          }),
        DatabaseConfigError,
      );
    }
    assert.throws(
      () =>
        readDatabaseConfig({
          DATABASE_URL: localUrl,
          DATABASE_SSL: 'false',
          DATABASE_CA_CERT: '/tmp/ca.pem',
        }),
      DatabaseConfigError,
    );
  });

  it('测试环境必须显式指定测试库，而且不能继承开发库的 SSL 设置', () => {
    assert.throws(
      () =>
        readDatabaseConfig({
          NODE_ENV: 'test',
          DATABASE_URL: localUrl,
          DATABASE_SSL: 'false',
        }),
      /TEST_DATABASE_URL/,
    );
    const config = readDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: localUrl,
      DATABASE_SSL: 'false',
      DATABASE_CA_CERT: '/development/ca.pem',
      DATABASE_POOL_MAX: '10',
      TEST_DATABASE_URL: 'postgresql://tester:fake@localhost/isolated_test',
      TEST_DATABASE_POOL_MAX: '1',
    });
    assert.match(config.url, /isolated_test$/);
    assert.equal(config.ssl, true);
    assert.equal(config.caFile, undefined);
    assert.equal(config.max, 1);
  });
});

describe('数据库客户端与错误处理', () => {
  it('未配置 CA 时仍严格校验证书，创建和关闭连接池不触发联网', async () => {
    const database = createDatabase(
      readDatabaseConfig({ DATABASE_URL: localUrl }),
    );
    try {
      assert.deepEqual(database.db.$client.options.ssl, {
        rejectUnauthorized: true,
      });
    } finally {
      await database.close();
    }
  });

  it('读取不到 CA 文件时不会泄露文件路径或连接串', () => {
    assert.throws(
      () =>
        createDatabase({
          url: localUrl,
          ssl: true,
          max: 1,
          caFile: '/nonexistent/secret-database-certificate.pem',
        }),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseConfigError);
        assert.doesNotMatch(error.message, /secret|postgresql/);
        return true;
      },
    );
  });

  it('识别驱动错误和 Drizzle 包装的错误，隐藏未知错误内容', () => {
    const secret = 'postgresql://user:TOP_SECRET@localhost/database';
    const cause = Object.assign(new Error(secret), { code: '28P01' });
    assert.match(
      databaseErrorMessage(new Error(secret, { cause })),
      /认证失败/,
    );
    for (const error of [
      new Error(secret),
      secret,
      { code: secret },
      { code: '__proto__' },
    ]) {
      assert.equal(typeof databaseErrorMessage(error), 'string');
      assert.doesNotMatch(databaseErrorMessage(error), /TOP_SECRET|postgresql/);
    }
    assert.match(
      databaseErrorMessage({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
      /CA/,
    );
    for (const message of [
      '(ENOTFOUND) tenant/user TOP_SECRET not found',
      'Tenant/user not found',
    ]) {
      const poolerError = Object.assign(new Error(message), { code: 'XX000' });
      const result = databaseErrorMessage(
        new Error('query failed', { cause: poolerError }),
      );
      assert.match(result, /租户或用户/);
      assert.doesNotMatch(result, /TOP_SECRET/);
    }
    for (const message of ['internal error', 'tenant/user permission denied']) {
      assert.doesNotMatch(
        databaseErrorMessage({ code: 'XX000', message }),
        /重新复制/,
      );
    }
  });

  it('配置错误时连接检查命令返回失败状态，不打印密码', () => {
    const result = spawnSync(process.execPath, ['src/db/check.ts'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'https://user:TOP_SECRET@localhost/database',
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /数据库检查失败/);
    assert.doesNotMatch(result.stdout + result.stderr, /TOP_SECRET/);
  });
});
