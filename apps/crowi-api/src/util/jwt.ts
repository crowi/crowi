import jwt from 'jsonwebtoken';
import Crowi from 'src/crowi';
import Debug from 'debug';

const debug = Debug('crowi:util:jwt');

interface TokenPayload {
  userId: string;
  email: string;
  type: 'access' | 'refresh';
}

// Token expiration times
const ACCESS_TOKEN_EXPIRES_IN = '15m'; // 15 minutes
const REFRESH_TOKEN_EXPIRES_IN = '30d'; // 30 days

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

    const accessToken = jwt.sign(
      { ...payload, type: 'access' },
      secret,
      { 
        expiresIn: ACCESS_TOKEN_EXPIRES_IN,
        issuer: 'crowi',
      }
    );

    const refreshToken = jwt.sign(
      { ...payload, type: 'refresh' },
      secret,
      { 
        expiresIn: REFRESH_TOKEN_EXPIRES_IN,
        issuer: 'crowi',
      }
    );

    // Calculate expiration time in seconds
    const expiresIn = 15 * 60; // 15 minutes in seconds

    return {
      accessToken,
      refreshToken,
      expiresIn,
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