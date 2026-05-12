import type { Request, Response } from 'express';
import adminRequired from './adminRequired';

const buildResMock = () => {
  const res: { statusCode: number; jsonPayload: unknown; status: jest.Mock; json: jest.Mock } = {
    statusCode: 200,
    jsonPayload: null,
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((payload: unknown) => {
    res.jsonPayload = payload;
    return res;
  });
  return res;
};

describe('middlewares/adminRequired', () => {
  const mw = adminRequired();

  it('calls next() when req.user is admin', () => {
    const req = { user: { admin: true } } as unknown as Request;
    const res = buildResMock();
    const next = jest.fn();

    mw(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 403 ADMIN_REQUIRED when authenticated user is not admin', () => {
    const req = { user: { admin: false } } as unknown as Request;
    const res = buildResMock();
    const next = jest.fn();

    mw(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.jsonPayload).toEqual({
      error: {
        code: 'ADMIN_REQUIRED',
        message: 'Admin permission required',
        redirectTo: '/',
      },
    });
  });

  it('returns 401 AUTHENTICATION_REQUIRED when no req.user is present', () => {
    const req = {} as unknown as Request;
    const res = buildResMock();
    const next = jest.fn();

    mw(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.jsonPayload).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required',
        redirectTo: '/login',
      },
    });
  });
});
