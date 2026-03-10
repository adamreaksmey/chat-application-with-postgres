import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres/postgres.service';

export interface User {
  id: string;
  username: string;
  email: string;
  password: string;
  created_at: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly postgres: PostgresService) {}

  async createUser(params: {
    username: string;
    email: string;
    passwordHash: string;
  }): Promise<User> {
    const pool = this.postgres.getQueryPool();
    const result = await pool.query<User>(
      `
        INSERT INTO users (username, email, password)
        VALUES ($1, $2, $3)
        RETURNING id, username, email, password, created_at
      `,
      [params.username, params.email, params.passwordHash],
    );

    return result.rows[0];
  }

  async findByEmail(email: string): Promise<User | null> {
    const pool = this.postgres.getQueryPool();
    const result = await pool.query<User>(
      `
        SELECT id, username, email, password, created_at
        FROM users
        WHERE email = $1
      `,
      [email],
    );

    return result.rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const pool = this.postgres.getQueryPool();
    const result = await pool.query<User>(
      `
        SELECT id, username, email, password, created_at
        FROM users
        WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ?? null;
  }
}
