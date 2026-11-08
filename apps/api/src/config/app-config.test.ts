import { describe, expect, it } from 'vitest';
import { AppConfig, ConfigError } from './app-config.js';

const VALID = {
  DATABASE_URL: 'postgresql://user:s3cret-password@localhost:5432/attendsure',
  REDIS_URL: 'redis://:another-s3cret@localhost:6379',
  JWT_ACCESS_SECRET: 'test-only-signing-secret-that-is-long-enough',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  WEB_APP_URL: 'https://dashboard.example.test',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'Test <no-reply@example.test>',
};

describe('AppConfig.fromEnv', () => {
  it('applies safe defaults', () => {
    const config = AppConfig.fromEnv(VALID);
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.institutionTimezone).toBe('Africa/Accra');
    expect(config.isProduction).toBe(false);
  });

  it('reads and coerces values', () => {
    const config = AppConfig.fromEnv({ ...VALID, NODE_ENV: 'production', PORT: '8080', LOG_LEVEL: 'warn' });
    expect(config.port).toBe(8080);
    expect(config.isProduction).toBe(true);
  });

  it('refuses to start without a database URL', () => {
    expect(() => AppConfig.fromEnv({ REDIS_URL: VALID.REDIS_URL })).toThrow(ConfigError);
    try {
      AppConfig.fromEnv({ REDIS_URL: VALID.REDIS_URL });
    } catch (error) {
      expect((error as ConfigError).problems.join()).toContain('DATABASE_URL');
    }
  });

  it('rejects a non-Postgres database URL and a non-Redis Redis URL', () => {
    expect(() => AppConfig.fromEnv({ ...VALID, DATABASE_URL: 'mysql://localhost/db' })).toThrow(ConfigError);
    expect(() => AppConfig.fromEnv({ ...VALID, REDIS_URL: 'http://localhost:6379' })).toThrow(ConfigError);
  });

  it('rejects an invalid time zone and an out-of-range port', () => {
    expect(() => AppConfig.fromEnv({ ...VALID, INSTITUTION_TIMEZONE: 'Accra/Nowhere' })).toThrow(/IANA/);
    expect(() => AppConfig.fromEnv({ ...VALID, PORT: '70000' })).toThrow(ConfigError);
  });

  it('never puts secret values into the error message', () => {
    try {
      AppConfig.fromEnv({ ...VALID, PORT: 'not-a-number' });
      expect.fail('expected a ConfigError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('PORT');
      expect(message).not.toContain('s3cret');
    }
  });

  it('rejects an encryption key that is not 32 bytes and a short signing secret', () => {
    expect(() =>
      AppConfig.fromEnv({ ...VALID, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() => AppConfig.fromEnv({ ...VALID, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses the .env.example secrets and plain http in production', () => {
    const example = {
      ...VALID,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'local-dev-only-jwt-secret-change-me-in-production-0001',
      ENCRYPTION_KEY: Buffer.from('local-dev-only-key-not-for-prod!').toString('base64'),
      WEB_APP_URL: 'http://dashboard.example.test',
    };
    try {
      AppConfig.fromEnv(example);
      expect.fail('expected a ConfigError');
    } catch (error) {
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('JWT_ACCESS_SECRET');
      expect(problems).toContain('ENCRYPTION_KEY');
      expect(problems).toContain('WEB_APP_URL');
    }
    // The same example values are fine on a developer's machine.
    expect(() => AppConfig.fromEnv({ ...example, NODE_ENV: 'development' })).not.toThrow();
  });
});
