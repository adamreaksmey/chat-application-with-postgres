/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function run() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set. Please provide a Postgres connection string.',
    );
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const appliedResult = await client.query(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(appliedResult.rows.map((row) => row.version));

    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (applied.has(version)) {
        continue;
      }

      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');

      console.log(`Applying migration ${version}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES($1)',
          [version],
        );
        await client.query('COMMIT');
        console.log(`Migration ${version} applied.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed to apply migration ${version}:`, err);
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
