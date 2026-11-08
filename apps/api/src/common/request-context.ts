import type { Request } from 'express';

/** Who is asking and from where: recorded in audit entries and sessions. */
export interface RequestContext {
  requestId: string | undefined;
  ip: string | undefined;
  userAgent: string | undefined;
}

export function requestContextOf(req: Request & { id?: unknown }): RequestContext {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: typeof req.id === 'string' ? req.id : undefined,
    ip: req.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : undefined,
  };
}
