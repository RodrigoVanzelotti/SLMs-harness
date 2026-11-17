import { ErrorCode } from '@amazon-mvp/api-contract';
import { ApiError } from '../../common/api-error';
import { StructuredLogger } from '../../common/structured-logger';
import { UsersApi, UserRecord, UserWithSecret } from '../users/users.api';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionsApi } from './sessions.api';
import { generateSessionToken, hashSessionToken } from './session-token';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('produces an argon2id hash that verifies', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(passwords.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    await expect(passwords.verify(hash, 'wrong password entirely')).resolves.toBe(false);
  });

  it('salts: the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([passwords.hash('same password 123'), passwords.hash('same password 123')]);
    expect(a).not.toBe(b);
  });

  it('treats a malformed stored hash as a failed login, not a crash', async () => {
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});

class FakeUsers implements UsersApi {
  private readonly rows = new Map<string, UserWithSecret>();

  async create(input: { email: string; passwordHash: string; displayName: string }) {
    const record: UserWithSecret = {
      id: `user-${this.rows.size + 1}`,
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    this.rows.set(record.email, record);
    return strip(record);
  }
  async findById(id: string) {
    const found = [...this.rows.values()].find((row) => row.id === id);
    return found ? strip(found) : null;
  }
  async findByEmailWithSecret(email: string) {
    return this.rows.get(email) ?? null;
  }
  async existsByEmail(email: string) {
    return this.rows.has(email);
  }
  async findByIdWithSecret(id: string) {
    return [...this.rows.values()].find((row) => row.id === id) ?? null;
  }
  async updateDisplayName(id: string, displayName: string) {
    const row = (await this.findByIdWithSecret(id))!;
    row.displayName = displayName;
    return strip(row);
  }
  async updatePasswordHash(id: string, passwordHash: string) {
    (await this.findByIdWithSecret(id))!.passwordHash = passwordHash;
  }
  async updateEmail(id: string, email: string) {
    const row = (await this.findByIdWithSecret(id))!;
    this.rows.delete(row.email);
    row.email = email;
    this.rows.set(email, row);
    return strip(row);
  }
}

const strip = (row: UserWithSecret): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  createdAt: row.createdAt,
});

class FakeSessions implements Partial<SessionsApi> {
  readonly issued: string[] = [];
  readonly revoked: string[] = [];

  async issue(userId: string) {
    this.issued.push(userId);
    return { token: `token-for-${userId}`, expiresAt: new Date(Date.now() + 3600_000) };
  }

  async revoke(token: string) {
    this.revoked.push(token);
  }

  readonly revokedOthers: Array<[string, string]> = [];
  async revokeOthersForUser(userId: string, keepSessionId: string) {
    this.revokedOthers.push([userId, keepSessionId]);
    return 2;
  }
}
