import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import supertest from 'supertest';

import app from '#src/server.ts';

describe('基础 API', () => {
  const agent = supertest(app);

  it('GET /health 返回 API 存活状态', async () => {
    const response = await agent.get('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: { status: 'ok' } });
  });

  it('未知路径返回统一 404 响应', async () => {
    const response = await agent.get('/api/unknown');
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  });

  it('非法 JSON 返回 400', async () => {
    const response = await agent
      .post('/health')
      .set('content-type', 'application/json')
      .send('{');
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: { code: 'INVALID_JSON', message: 'JSON 格式无效。' } });
  });
});
