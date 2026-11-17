import { ErrorCode } from '@amazon-mvp/api-contract';
import { ApiError } from '../../common/api-error';
import { StructuredLogger } from '../../common/structured-logger';
import { UsersApi, UserRecord, UserWithSecret } from '../users/users.api';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionsApi } from './sessions.api';
import { generateSessionToken, hashSessionToken } from './session-token';

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

describe('AccountService', () => {
  const build = async () => {
    const users = new FakeUsers();
    const sessions = new FakeSessions();
    const passwords = new PasswordService();
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as StructuredLogger;
    const user = await users.create({
      email: 'ada@example.com',
      passwordHash: await passwords.hash('correct horse battery staple'),
      displayName: 'Ada Lovelace',
    });
    const service = new AccountService(
      users,
      passwords,
      sessions as unknown as SessionsApi,
      logger,
    );
    return { users, sessions, service, logger, session: { userId: user.id, sessionId: 's-1' } };
  };

  it('changes the password, keeps the current session and revokes the others', async () => {
    const { service, sessions, users, session, logger } = await build();
    const result = await service.changePassword(
      session,
      'correct horse battery staple',
      'another long passphrase',
    );
    expect(result).toEqual({ success: true, revokedSessions: 2 });
    expect(sessions.revokedOthers).toEqual([[session.userId, 's-1']]);
    const stored = (await users.findByIdWithSecret(session.userId))!;
    await expect(
      new PasswordService().verify(stored.passwordHash, 'another long passphrase'),
    ).resolves.toBe(true);
    const logged = JSON.stringify([
      (logger.log as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
    ]);
    expect(logged).not.toContain('another long passphrase');
    expect(logged).not.toContain('correct horse battery staple');
  });

  it('rejects a wrong current password with the login error code and changes nothing', async () => {
    const { service, sessions, users, session } = await build();
    const before = (await users.findByIdWithSecret(session.userId))!.passwordHash;
    const error = await service
      .changePassword(session, 'wrong password here', 'another long passphrase')
      .catch((reason: ApiError) => reason);
    expect((error as ApiError).code).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
    expect((error as ApiError).getStatus()).toBe(403);
    expect((await users.findByIdWithSecret(session.userId))!.passwordHash).toBe(before);
    expect(sessions.revokedOthers).toEqual([]);
  });

  it('refuses to "change" the password to the same value', async () => {
    const { service, session } = await build();
    await expect(
      service.changePassword(session, 'correct horse battery staple', 'correct horse battery staple'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('changes the e-mail only with the password and never onto a taken address', async () => {
    const { service, users, session, sessions } = await build();
    await users.create({ email: 'taken@example.com', passwordHash: 'x', displayName: 'Other' });
    await expect(
      service.changeEmail(session, 'new@example.com', 'wrong password here'),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_INVALID_CREDENTIALS });
    await expect(
      service.changeEmail(session, 'taken@example.com', 'correct horse battery staple'),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_EMAIL_ALREADY_REGISTERED });
    const profile = await service.changeEmail(
      session,
      'new@example.com',
      'correct horse battery staple',
    );
    expect(profile.email).toBe('new@example.com');
    expect(profile).not.toHaveProperty('passwordHash');
    expect(sessions.revokedOthers).toEqual([[session.userId, 's-1']]);
  });

  it('updates the display name', async () => {
    const { service, session } = await build();
    await expect(service.updateProfile(session.userId, 'Ada King')).resolves.toMatchObject({
      displayName: 'Ada King',
    });
  });
});
