import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../../db/schema';
import { verifyPassword, signToken, verifyToken, requireAuth, auditLog, type AuthUser } from '../../auth';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

authRouter.post('/login', loginLimiter, (req: Request, res: Response): void => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email) as
    (AuthUser & { password_hash: string; is_active: number }) | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    auditLog(null, email, 'LOGIN_FAILED', 'user', undefined, undefined, req.ip);
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signToken({ id: user.id, email: user.email, role: user.role });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  });

  auditLog(user.id, user.email, 'LOGIN_SUCCESS', 'user', user.id, undefined, req.ip);
  logger.info(`Login: ${email}`);

  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// Always clears the cookie; audits if token was valid
authRouter.post('/logout', (req: Request, res: Response): void => {
  const token = req.cookies?.['auth_token'] as string | undefined;
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      auditLog(payload.sub, payload.email, 'LOGOUT', 'user', payload.sub, undefined, req.ip);
    }
  }
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

// Requires valid session — returns current user identity
authRouter.get('/me', requireAuth, (req: Request, res: Response): void => {
  res.json({ user: req.user });
});
