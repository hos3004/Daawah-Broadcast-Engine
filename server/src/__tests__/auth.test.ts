import { hashPassword, verifyPassword, signToken, verifyToken } from '../auth';

// Minimal unit tests for auth utilities — no DB, no network
describe('auth utilities', () => {
  const plain = 'TestPassword123!';

  it('hashPassword produces a bcrypt hash', () => {
    const hash = hashPassword(plain);
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  it('verifyPassword returns true for correct password', () => {
    const hash = hashPassword(plain);
    expect(verifyPassword(plain, hash)).toBe(true);
  });

  it('verifyPassword returns false for wrong password', () => {
    const hash = hashPassword(plain);
    expect(verifyPassword('WrongPassword', hash)).toBe(false);
  });

  it('signToken + verifyToken round-trip', () => {
    process.env['JWT_SECRET'] = 'a'.repeat(64);
    const user = { id: 'test-id', email: 'test@example.com', role: 'admin' as const };
    const token = signToken(user);
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('test-id');
    expect(payload?.email).toBe('test@example.com');
    expect(payload?.role).toBe('admin');
  });

  it('verifyToken returns null for invalid token', () => {
    process.env['JWT_SECRET'] = 'a'.repeat(64);
    expect(verifyToken('invalid.token.here')).toBeNull();
  });
});
