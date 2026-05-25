import jwt from 'jsonwebtoken';
import Crowi from 'src/crowi';
import Debug from 'debug';

const debug = Debug('crowi:util:jwt');

interface TokenPayload {
  userId: string;
  email: string;
  type: 'access' | 'refresh';
}

/**
 * Access / refresh token lifetimes in seconds. Env-overridable; the
 * 1h default for access tokens is long enough that brief idle periods
 * don't churn the refresh endpoint and short enough that a leaked
 * token stays useful for at most an hour. The client's 401 interceptor
 * (see `packages/web/src/lib/api-client.ts`) trades the refresh token
 * for a fresh access token whenever a request lands a 401.
 */
const ACCESS_TOKEN_TTL_SEC = Number(process.env.JWT_ACCESS_TOKEN_TTL_SECONDS) || 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SEC = Number(process.env.JWT_REFRESH_TOKEN_TTL_SECONDS) || 30 * 24 * 60 * 60; // 30 days

export function createJwtUtil(crowi: Crowi) {
  const config = crowi.getConfig();
  const secret = config.crowi['app:secret'] || config.crowi['SECRET_TOKEN'] || 'your-secret-key';

  /**
   * Generate access and refresh tokens for a user
   */
  function generateTokens(user: any) {
    const payload = {
      userId: user._id.toString(),
      email: user.email,
    };

    const accessToken = jwt.sign({ ...payload, type: 'access' }, secret, {
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      issuer: 'crowi',
    });

    const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, secret, {
      expiresIn: REFRESH_TOKEN_TTL_SEC,
      issuer: 'crowi',
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
    };
  }

  /**
   * Verify and decode a token
   */
  function verifyToken(token: string, type: 'access' | 'refresh'): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        issuer: 'crowi',
      }) as TokenPayload;

      if (decoded.type !== type) {
        debug(`Invalid token type. Expected ${type}, got ${decoded.type}`);
        return null;
      }

      return decoded;
    } catch (error) {
      debug('Token verification failed:', error);
      return null;
    }
  }

  /**
   * Extract token from Authorization header
   */
  function extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    return parts[1];
  }

  /**
   * Generate a new access token from a refresh token
   */
  async function refreshAccessToken(refreshToken: string) {
    const payload = verifyToken(refreshToken, 'refresh');
    if (!payload) {
      return null;
    }

    const User = crowi.model('User');
    const user = await User.findById(payload.userId);

    if (!user || user.status !== User.STATUS_ACTIVE) {
      return null;
    }

    return generateTokens(user);
  }

  return {
    generateTokens,
    verifyToken,
    extractTokenFromHeader,
    refreshAccessToken,
  };
}
