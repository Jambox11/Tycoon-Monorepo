import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Observable, of, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { RedisService } from '../../modules/redis/redis.service';
import { Reflector } from '@nestjs/core';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';

interface StoredIdempotentResponse {
  statusCode: number;
  body: any;
  bodyHash: string;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const isIdempotent = this.reflector.get<boolean>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );

    if (!isIdempotent) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const idempotencyKey = this.extractIdempotencyKey(request);

    if (!idempotencyKey) {
      // If the decorator is present, we require the key
      throw new BadRequestException('X-Idempotency-Key header is required');
    }

    const userId = request.user?.id;
    const redisKey = `idempotency:${userId || 'anon'}:${idempotencyKey}`;

    // Bind the key to the request payload so a replay with a different body
    // cannot silently return a response for a different purchase.
    const bodyHash = this.hashBody(request.body);

    // Check if we have a cached response
    const cachedResponse = (await this.redisService.get(
      redisKey,
    )) as StoredIdempotentResponse | null;
    if (cachedResponse) {
      if (cachedResponse.bodyHash && cachedResponse.bodyHash !== bodyHash) {
        throw new ConflictException(
          'Idempotency-Key was already used with a different request payload',
        );
      }
      const response = context.switchToHttp().getResponse();
      response.status(cachedResponse.statusCode);
      return of(cachedResponse.body);
    }

    // Handle concurrent requests with the same key using a temporary lock.
    // The lock is set with a TTL so a crashed request cannot deadlock the key
    // forever; a retry after the TTL can safely re-attempt the operation.
    const lockKey = `${redisKey}:lock`;
    const acquiredLock = await this.redisService.incrementRateLimit(
      lockKey,
      10,
    );
    if (acquiredLock > 1) {
      throw new ConflictException(
        'A request with this idempotency key is already in progress',
      );
    }

    return next.handle().pipe(
      tap(async (body) => {
        const response = context.switchToHttp().getResponse();
        const statusCode = response.statusCode || HttpStatus.OK;

        // Cache the response for 24 hours
        await this.redisService.set(
          redisKey,
          { statusCode, body, bodyHash },
          24 * 60 * 60,
        );
        await this.redisService.del(lockKey);
      }),
      catchError((err) => {
        // Release the lock on failure so the client can retry the same key.
        // Log with the correlation id so money-adjacent failures are traceable.
        const requestId =
          request.id || request.headers['x-request-id'] || undefined;
        this.logger.warn(
          `Idempotent request failed key=${idempotencyKey} requestId=${requestId} status=${err?.status ?? 'unknown'}`,
        );
        return this.redisService.del(lockKey).then(() => throwError(() => err));
      }),
    );
  }

  /**
   * Resolve the idempotency key from the request. HTTP callers use the
   * X-Idempotency-Key / Idempotency-Key headers, while WS reconnect retries
   * (roll/buy/end-turn) carry the key on the message payload or handshake
   * query. Keeping a single resolver guarantees the same key is honored
   * regardless of transport so duplicate actions are not double-applied.
   */
  private extractIdempotencyKey(request: any): string | undefined {
    const headerKey =
      request?.headers?.['x-idempotency-key'] ||
      request?.headers?.['idempotency-key'];
    if (headerKey) {
      return Array.isArray(headerKey) ? headerKey[0] : headerKey;
    }

    const payloadKey =
      request?.body?.idempotencyKey ||
      request?.body?.idempotency_key ||
      request?.data?.idempotencyKey ||
      request?.data?.idempotency_key;
    if (payloadKey) {
      return String(payloadKey);
    }

    const queryKey =
      request?.query?.idempotencyKey || request?.query?.idempotency_key;
    if (queryKey) {
      return Array.isArray(queryKey) ? queryKey[0] : String(queryKey);
    }

    return undefined;
  }

  private hashBody(body: unknown): string {
    const serialized = this.stableStringify(body ?? null);
    return createHash('sha256').update(serialized).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${this.stableStringify(
            (value as Record<string, unknown>)[key],
          )}`,
      );
    return `{${entries.join(',')}}`;
  }
}
