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

describe('AuthService', () => {
  const build = () => {
    const users = new FakeUsers();
    const sessions = new FakeSessions();

    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as StructuredLogger;
    return {
      users,
      sessions,
      service: new AuthService(
        users,
        new PasswordService(),
        sessions as unknown as SessionsApi,
        logger,
      ),
    };
  };

  const credentials = {
    email: 'ada@example.com',
    password: 'correct horse battery staple',
    displayName: 'Ada Lovelace',
  };

  it('registers a user, hashes the password and starts a session', async () => {
    const { service, sessions } = build();
    const result = await service.register(credentials);

    expect(result.profile.email).toBe('ada@example.com');
    expect(result.session.token).toBe('token-for-user-1');
    expect(sessions.issued).toEqual(['user-1']);
    expect(JSON.stringify(result)).not.toContain(credentials.password);
  });

  it('rejects a duplicate email', async () => {
    const { service } = build();
    await service.register(credentials);
    await expect(service.register(credentials)).rejects.toMatchObject({
      code: ErrorCode.AUTH_EMAIL_ALREADY_REGISTERED,
    });
  });

  it('logs in with valid credentials', async () => {
    const { service } = build();
    await service.register(credentials);
    const result = await service.login({ email: credentials.email, password: credentials.password });
    expect(result.profile.id).toBe('user-1');
  });

  it('returns the same generic error for a wrong password and an unknown email', async () => {
    const { service } = build();
    await service.register(credentials);

    const wrongPassword = await service
      .login({ email: credentials.email, password: 'definitely wrong pw' })
      .catch((error: ApiError) => error);
    const unknownEmail = await service
      .login({ email: 'nobody@example.com', password: credentials.password })
      .catch((error: ApiError) => error);

    expect((wrongPassword as ApiError).code).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
    expect((unknownEmail as ApiError).code).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
    expect((wrongPassword as ApiError).message).toBe((unknownEmail as ApiError).message);
    expect((wrongPassword as ApiError).getStatus()).toBe((unknownEmail as ApiError).getStatus());
  });

  it('identify reports existence without leaking anything else about the account', async () => {
    const { service } = build();
    await service.register(credentials);

    await expect(service.identify(credentials.email)).resolves.toEqual({ exists: true });
    await expect(service.identify('nobody@example.com')).resolves.toEqual({ exists: false });
  });

  it('revokes the session on logout and tolerates a missing cookie', async () => {
    const { service, sessions } = build();
    await service.logout('token-for-user-1');
    await service.logout(undefined);
    expect(sessions.revoked).toEqual(['token-for-user-1']);
  });
});
