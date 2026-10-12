// Synthetic fixture for the verifier tests. Not part of the product.
export interface User {
  id: string;
  name: string;
  token: string | null;
  roles: string[];
}

export interface Session {
  user: User;
  expiresAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export function createSession(user: User, now: number): Session {
  return { user, expiresAt: now + SESSION_TTL_MS };
}

export function isExpired(session: Session, now: number): boolean {
  return session.expiresAt <= now;
}

export function hasRole(user: User, role: string): boolean {
  return user.roles.includes(role);
}

export function canAccess(user: User, resource: string): boolean {
  if (!user.token) return false;
  if (resource.startsWith('admin/')) {
    return hasRole(user, 'admin');
  }
  return true;
}

export function describe(user: User): string {
  return `${user.name} (${user.roles.join(', ')})`;
}
