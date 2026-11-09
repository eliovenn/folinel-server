/* eslint-disable no-process-env */
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import logger from 'jet-logger';
import morgan from 'morgan';

import { publicError } from './http/errors.ts';
import { authRequestBoundary, currentUserHandler, nativeAuthHandler, registrationRoutes } from './modules/auth/routes.ts';
import type { AuthService } from './modules/auth/service.ts';

function bodyParserErrorType(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof error.type === 'string'
  ) {
    return error.type;
  }
  return undefined;
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const type = bodyParserErrorType(error);
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON 格式无效。' } });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求正文过大。' } });
    return;
  }
  const safe = publicError(error);
  if (safe.status >= 500 && process.env.NODE_ENV !== 'test') {
    // 不记录未知异常原文，防止它携带 SQL、凭据或请求正文。
    logger.err('未处理的 API 错误。');
  }
  if (safe.retryAfter) res.setHeader('Retry-After', String(safe.retryAfter));
  res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
};

export function createApp({ auth, trustProxy = [] }: { auth?: AuthService; trustProxy?: string[] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy.length ? trustProxy : false);
  app.use(helmet());
  if (process.env.NODE_ENV === 'development') {
    // 不记录 URL/query，避免回调凭据或用户输入进入访问日志。
    app.use(morgan(':method :status :response-time ms'));
  }
  if (auth) {
    app.use(['/api/auth', '/api/v1/auth'], authRequestBoundary(auth));
    app.all('/api/auth/{*path}', nativeAuthHandler(auth));
  }
  app.use(express.json({ limit: '1mb' }));
  /** 基础存活检查；数据库连接在 main.ts 启动前已经单独验证。 */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ data: { status: 'ok' } });
  });
  if (auth) {
    app.use('/api/v1/auth', registrationRoutes(auth));
    app.get('/api/v1/me', currentUserHandler(auth));
  }
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  });
  app.use(errorHandler);
  return app;
}

export default createApp();
