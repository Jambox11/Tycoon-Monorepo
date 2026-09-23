import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../modules/redis/redis.service';

export const RateLimit = (limit: number, ttl: number = 60) =>
  Reflect.metadata('rateLimit', { limit, ttl });

interface RateLimitRequest {
  ip?: string;
  route?: { path: string };
  url: string;
  user?: { sub?: string; id?: string };
  headers?: Record<string, string | string[] | undefined>;
  handshake?: { auth?: { token?: string }; headers?: Record<string, string | string[] | undefined> };
}

@Injectable()
export class RedisRateLimitGuard implements CanActivate {
  constructor(
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rateLimitConfig = this.reflector.get<
      | {
          limit: number;
          ttl: number;
        }
      | undefined
    >('rateLimit', context.getHandler());
    if (!rateLimitConfig) {
      return true;
    }

    const request = this.getRequest(context);
    const key = this.buildKey(context, request);

    const current = await this.redisService.incrementRateLimit(
      key,
      Number(rateLimitConfig.ttl),
    );

    if (current > rateLimitConfig.limit) {
      throw new HttpException(
        'Rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private getRequest(context: ExecutionContext): RateLimitRequest {
    if (context.getType<'http' | 'ws'>() === 'ws') {
      return context.switchToWs().getClient<RateLimitRequest>();
    }
    return context.switchToHttp().getRequest<RateLimitRequest>();
  }

  private buildKey(
    context: ExecutionContext,
    request: RateLimitRequest,
  ): string {
    const route =
      request.route?.path ||
      context.getHandler().name ||
      request.url ||
      'unknown';

    // Prefer the authenticated principal so reconnect retries from the same
    // seat share a bucket; fall back to the socket/peer address for
    // unauthenticated handshakes (deny-by-default still applies upstream).
    const principal =
      request.user?.sub ||
      request.user?.id ||
      this.extractToken(request) ||
      request.ip ||
      'anonymous';

    return `rate_limit:${principal}:${route}`;
  }

  private extractToken(request: RateLimitRequest): string | undefined {
    const token =
      request.handshake?.auth?.token ||
      this.readHeader(request.headers, 'authorization') ||
      this.readHeader(request.handshake?.headers, 'authorization');

    if (!token) {
      return undefined;
    }

    // Never log or persist raw tokens; use a short stable fingerprint only.
    return `tok:${this.fingerprint(token)}`;
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined> | undefined,
    name: string,
  ): string | undefined {
    if (!headers) {
      return undefined;
    }
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private fingerprint(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }
}
