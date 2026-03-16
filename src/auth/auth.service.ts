import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService, User } from '../users/users.service';
import { PostgresService } from '../postgres/postgres.service';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly postgres: PostgresService,
    private readonly jwtService: JwtService,
  ) {}

  private get accessTokenTtlSeconds(): number {
    return 7 * 24 * 60 * 60; // 7 days
  }

  private get refreshTokenTtlDays(): number {
    return 30;
  }

  private async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 12);
  }

  private async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  private async hashRefreshToken(token: string): Promise<string> {
    return bcrypt.hash(token, 12);
  }

  private signAccessToken(user: User): string {
    const payload = {
      sub: user.id,
      username: user.username,
    };
    return this.jwtService.sign(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: this.accessTokenTtlSeconds,
    });
  }

  private signRefreshToken(user: User): string {
    const payload = {
      sub: user.id,
      username: user.username,
      type: 'refresh',
    };
    return this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: `${this.refreshTokenTtlDays}d`,
    });
  }

  async register(params: {
    username: string;
    email: string;
    password: string;
  }): Promise<{ user: User; tokens: AuthTokens }> {
    const found = await this.findUserByEmailOrUsername(
      params.email,
      params.username,
    );
    if (found) {
      return {
        user: found,
        tokens: await this.createSessionAndTokens(found, undefined),
      };
    }

    const passwordHash = await this.hashPassword(params.password);
    const user = await this.usersService.createUser({
      username: params.username,
      email: params.email,
      passwordHash,
    });

    const tokens = await this.createSessionAndTokens(user, undefined);
    return { user, tokens };
  }

  async findUserByEmailOrUsername(
    email: string,
    username: string,
  ): Promise<User | null> {
    return (
      this.usersService.findByEmail(email) ??
      this.usersService.findByUsername(username)
    );
  }

  async validateUser(email: string, password: string): Promise<User> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await this.verifyPassword(password, user.password);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }

  async login(params: {
    email: string;
    password: string;
    deviceInfo?: string;
  }): Promise<{ user: User; tokens: AuthTokens }> {
    const user = await this.validateUser(params.email, params.password);
    const tokens = await this.createSessionAndTokens(user, params.deviceInfo);
    return { user, tokens };
  }

  async refresh(
    refreshToken: string,
  ): Promise<{ user: User; tokens: AuthTokens }> {
    const payload = this.jwtService.verify(refreshToken, {
      secret: process.env.JWT_REFRESH_SECRET,
    });

    if (!payload || payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const result = await this.postgres.query(
      `
        SELECT id, refresh_token, user_id, revoked_at, expires_at
        FROM sessions
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
      `,
      [user.id],
    );

    const sessions = result.rows as Array<{
      id: string;
      refresh_token: string;
      user_id: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>;

    let matchedSession: (typeof sessions)[number] | null = null;
    for (const session of sessions) {
      const match = await bcrypt.compare(refreshToken, session.refresh_token);
      if (match) {
        matchedSession = session;
        break;
      }
    }

    if (!matchedSession) {
      throw new UnauthorizedException('Refresh token not recognized');
    }

    const tokens = await this.createSessionAndTokens(user, undefined);

    await this.postgres.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE id = $1',
      [matchedSession.id],
    );

    return { user, tokens };
  }

  async logout(sessionId: string | null, userId: string): Promise<void> {
    if (sessionId) {
      await this.postgres.query(
        'UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2',
        [sessionId, userId],
      );
      return;
    }

    await this.postgres.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }

  private async createSessionAndTokens(
    user: User,
    deviceInfo?: string,
  ): Promise<AuthTokens> {
    const accessToken = this.signAccessToken(user);
    const refreshToken = this.signRefreshToken(user);
    const hashedRefresh = await this.hashRefreshToken(refreshToken);

    await this.postgres.query(
      `
        INSERT INTO sessions (user_id, refresh_token, device_info, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '${this.refreshTokenTtlDays} days')
      `,
      [user.id, hashedRefresh, deviceInfo ?? this.postgres.getNodeId()],
    );

    return { accessToken, refreshToken };
  }
}
