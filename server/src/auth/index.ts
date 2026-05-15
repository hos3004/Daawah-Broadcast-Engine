import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { getDb } from '../db/schema';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

export type Role = 'admin' | 'editor' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  iat?: number;
  exp?: number;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, config.security.bcryptRounds);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function signToken(user: AuthUser): string {
  const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
  return jwt.sign(payload, config.security.jwtSecret, { expiresIn: '24h' });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.security.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.['auth_token'] as string | undefined
    ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function auditLog(
  userId: string | null,
  userEmail: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  detail?: string,
  ipAddress?: string
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_logs (id, user_id, user_email, action, entity_type, entity_id, detail, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), userId, userEmail, action, entityType ?? null, entityId ?? null, detail ?? null, ipAddress ?? null);
  } catch (err) {
    logger.error('Failed to write audit log', err);
  }
}

export function ensureAdminUser(): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existing) {
    const id = uuidv4();
    const hash = hashPassword(config.admin.password);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin')
    `).run(id, config.admin.email, hash);
    logger.info(`Created default admin user: ${config.admin.email}`);
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
