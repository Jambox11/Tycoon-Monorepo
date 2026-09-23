import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { Socket } from 'socket.io';

/**
 * Stable error codes surfaced to clients for auth failures.
 * Kept in sync with REST error mapping so WS and REST behave identically.
 */
export const AUTH_ERROR_CODES = {
  MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  EXPIRED_TOKEN: 'AUTH_EXPIRED_TOKEN',
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export interface AuthenticatedUser {
  sub: string;
  [key: string]: unknown;
}

/**
 * Extracts a bearer token from either an HTTP request or a Socket.IO client.
 *
 * Parity rules (ADR-002):
 * - REST: `Authorization: Bearer <jwt>` header, falling back to the
 *   `access_token` cookie.
 * - WS:   handshake `auth.token`, then the `Authorization` handshake header,
 *   then the `access_token` cookie. This lets the same JWT issued for REST
 *   authenticate the socket handshake without a second login.
 */
export function extractToken(
  context: ExecutionContext,
): string | undefined {
  const type = context.getType<'http' | 'ws'>();

  if (type === 'ws') {
    const client = context.switchToWs().getClient<Socket>();
    const handshake = client?.handshake;
    if (!handshake) {
      return undefined;
    }

    const authToken = (handshake.auth as Record<string, unknown> | undefined)
      ?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }

    const header = handshake.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }

    return readCookieToken(handshake.headers?.cookie);
  }

  const request = context.switchToHttp().getRequest<Request>();
  const header = request?.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  return readCookieToken(request?.headers?.cookie);
}

function readCookieToken(cookieHeader?: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'access_token') {
      const value = rest.join('=').trim();
      return value.length > 0 ? decodeURIComponent(value) : undefined;
    }
  }
  return undefined;
}

/**
 * Deny-by-default auth guard shared by REST controllers and the GamesGateway.
 *
 * On success the verified payload is attached to `request.user` (HTTP) or
 * `client.data.user` (WS) so downstream handlers can authorize seat vs
 * spectator without re-parsing the token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const token = extractToken(context);
    if (!token) {
      throw this.unauthorized(AUTH_ERROR_CODES.MISSING_TOKEN);
    }

    let payload: AuthenticatedUser;
    try {
      payload = await this.jwtService.verifyAsync<AuthenticatedUser>(token);
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const code =
        name === 'TokenExpiredError'
          ? AUTH_ERROR_CODES.EXPIRED_TOKEN
          : AUTH_ERROR_CODES.INVALID_TOKEN;
      throw this.unauthorized(code);
    }

    if (!payload?.sub) {
      throw this.unauthorized(AUTH_ERROR_CODES.INVALID_TOKEN);
    }

    if (context.getType<'http' | 'ws'>() === 'ws') {
      const client = context.switchToWs().getClient<Socket>();
      client.data = { ...(client.data ?? {}), user: payload };
    } else {
      const request = context.switchToHttp().getRequest<Request>();
      (request as Request & { user?: AuthenticatedUser }).user = payload;
    }

    return true;
  }

  private unauthorized(code: AuthErrorCode): UnauthorizedException {
    return new UnauthorizedException({
      statusCode: 401,
      error: 'Unauthorized',
      code,
      message: 'Authentication required',
    });
  }
}
