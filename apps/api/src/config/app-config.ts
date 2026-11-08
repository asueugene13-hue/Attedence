import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  INSTITUTION_TIMEZONE: z
    .string()
    .default('Africa/Accra')
    .refine(isValidTimeZone, 'must be an IANA time zone'),
});

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validated, typed configuration. Built once at start-up from environment variables; the app refuses to
 * start if anything is missing or malformed, rather than failing later in the middle of a request.
 */
export class AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly institutionTimezone: string;

  private constructor(env: z.infer<typeof EnvSchema>) {
    this.nodeEnv = env.NODE_ENV;
    this.port = env.PORT;
    this.logLevel = env.LOG_LEVEL;
    this.databaseUrl = env.DATABASE_URL;
    this.redisUrl = env.REDIS_URL;
    this.institutionTimezone = env.INSTITUTION_TIMEZONE;
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  /** Error messages name the variable and the rule, never the value, so secrets cannot leak into logs. */
  static fromEnv(env: Record<string, string | undefined>): AppConfig {
    const parsed = EnvSchema.safeParse(env);
    if (!parsed.success) {
      throw new ConfigError(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    return new AppConfig(parsed.data);
  }
}
