import { Express, Request, Response } from 'express';
import Crowi from 'src/crowi';
import Debug from 'debug';
import { createJwtUtil } from '../util/jwt';
import { ApiErrorSchema } from '@crowi/api-contract';
import { z } from 'zod';

type ApiError = z.infer<typeof ApiErrorSchema>;

export default (crowi: Crowi, app: Express) => {
  const debug = Debug('crowi:controllers:tokenAuth');
  const User = crowi.model('User');
  const Config = crowi.model('Config');
  const jwtUtil = createJwtUtil(crowi);

  const actions = {} as {
    login: (req: Request, res: Response) => Promise<Response>;
    register: (req: Request, res: Response) => Promise<Response>;
    refresh: (req: Request, res: Response) => Promise<Response>;
    logout: (req: Request, res: Response) => Promise<Response>;
    me: (req: Request, res: Response) => Promise<Response>;
  };

  /**
   * POST /auth/login
   * Authenticate user and return tokens
   */
  actions.login = async (req: Request, res: Response) => {
    const { email, password } = req.body;

    try {
      // Find user by email
      const user = await User.findUserByEmail(email);
      if (!user) {
        const error: ApiError = {
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
          },
        };
        return res.status(401).json(error);
      }

      // Check user status
      if (user.status !== User.STATUS_ACTIVE) {
        let code = 'USER_NOT_ACTIVE';
        let message = 'User account is not active';

        if (user.status === User.STATUS_REGISTERED) {
          code = 'USER_REGISTERED';
          message = 'User registration is not complete';
        } else if (user.status === User.STATUS_SUSPENDED) {
          code = 'USER_SUSPENDED';
          message = 'User account is suspended';
        } else if (user.status === User.STATUS_INVITED) {
          code = 'USER_INVITED';
          message = 'User invitation is pending';
        }

        const error: ApiError = {
          error: { code, message },
        };
        return res.status(403).json(error);
      }

      // Verify password
      const isPasswordValid = await user.isPasswordValid(password);
      if (!isPasswordValid) {
        const error: ApiError = {
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
          },
        };
        return res.status(401).json(error);
      }

      // Generate tokens
      const tokens = jwtUtil.generateTokens(user);

      // Return success response
      return res.json({
        ...tokens,
        user: {
          id: user._id.toString(),
          username: user.username,
          email: user.email,
          name: user.name,
          image: user.image,
        },
      });
    } catch (error) {
      debug('Login error:', error);
      const apiError: ApiError = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred during login',
        },
      };
      return res.status(500).json(apiError);
    }
  };

  /**
   * POST /auth/register
   * Register new user and return tokens
   */
  actions.register = async (req: Request, res: Response) => {
    const { username, name, email, password } = req.body;

    try {
      // Check if registration is restricted
      const config = (await Config.loadAllConfig()) as { crowi: Record<string, any> };
      if (config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_CLOSED) {
        const error: ApiError = {
          error: {
            code: 'REGISTRATION_CLOSED',
            message: 'User registration is closed',
          },
        };
        return res.status(403).json(error);
      }

      // Check if user already exists
      const existingUser = await User.findOne({
        $or: [{ email: email }, { username: username }],
      });

      if (existingUser) {
        const error: ApiError = {
          error: {
            code: 'USER_EXISTS',
            message: existingUser.email === email ? 'Email already registered' : 'Username already taken',
          },
        };
        return res.status(409).json(error);
      }

      // Create new user
      interface UserDocument {
        _id: any;
        username: string;
        email: string;
        name: string;
        image?: string;
      }

      const newUser = await new Promise<UserDocument | null>((resolve, reject) => {
        User.createUserByEmailAndPassword(
          name,
          username,
          email,
          password,
          'en', // default language
          (err: Error | null, user: UserDocument | null) => {
            if (err) reject(err);
            else resolve(user);
          },
        );
      });

      if (!newUser) {
        const error: ApiError = {
          error: {
            code: 'REGISTRATION_FAILED',
            message: 'Failed to create user',
          },
        };
        return res.status(400).json(error);
      }

      // Generate tokens
      const tokens = jwtUtil.generateTokens(newUser);

      // Return success response
      return res.status(201).json({
        ...tokens,
        user: {
          id: newUser._id.toString(),
          username: newUser.username,
          email: newUser.email,
          name: newUser.name,
          image: newUser.image,
        },
      });
    } catch (error) {
      debug('Registration error:', error);
      const apiError: ApiError = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred during registration',
        },
      };
      return res.status(500).json(apiError);
    }
  };

  /**
   * POST /auth/refresh
   * Refresh access token using refresh token
   */
  actions.refresh = async (req: Request, res: Response) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      const error: ApiError = {
        error: {
          code: 'REFRESH_TOKEN_REQUIRED',
          message: 'Refresh token is required',
        },
      };
      return res.status(400).json(error);
    }

    try {
      const tokens = await jwtUtil.refreshAccessToken(refreshToken);

      if (!tokens) {
        const error: ApiError = {
          error: {
            code: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid or expired refresh token',
          },
        };
        return res.status(401).json(error);
      }

      // Get user data for response
      const payload = jwtUtil.verifyToken(refreshToken, 'refresh');
      if (!payload) {
        const error: ApiError = {
          error: {
            code: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid or expired refresh token',
          },
        };
        return res.status(401).json(error);
      }

      const user = await User.findById(payload.userId);

      if (!user) {
        const error: ApiError = {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
        };
        return res.status(404).json(error);
      }

      return res.json({
        ...tokens,
        user: {
          id: user._id.toString(),
          username: user.username,
          email: user.email,
          name: user.name,
          image: user.image,
        },
      });
    } catch (error) {
      debug('Token refresh error:', error);
      const apiError: ApiError = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred during token refresh',
        },
      };
      return res.status(500).json(apiError);
    }
  };

  /**
   * POST /auth/logout
   * Logout user (client should discard tokens)
   */
  actions.logout = async (req: Request, res: Response) => {
    // In a stateless JWT system, logout is handled client-side
    // We could implement a token blacklist here if needed
    return res.json({ message: 'Logged out successfully' });
  };

  /**
   * GET /auth/me
   * Get current user information
   */
  actions.me = async (req: Request, res: Response) => {
    // User should be attached to request by auth middleware
    const user = req.user;

    if (!user) {
      const error: ApiError = {
        error: {
          code: 'UNAUTHORIZED',
          message: 'User not found',
        },
      };
      return res.status(401).json(error);
    }

    return res.json({
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        name: user.name,
        image: user.image,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
      },
    });
  };

  return actions;
};
