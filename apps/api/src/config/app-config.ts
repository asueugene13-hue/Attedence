import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Values in .env.example contain this marker; production refuses to start with them. */
const LOCAL_ONLY_MARKER = 'local-dev';

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const base64Key32 = z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
  message: 'must be 32 bytes encoded as base64 (see .env.example for how to generate one)',
});

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Reverse proxies in front of the API (load balancer, CDN). Used to find the real client IP for rate limits. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    INSTITUTION_TIMEZONE: z
      .string()
      .default('Africa/Accra')
      .refine(isValidTimeZone, 'must be an IANA time zone'),

    /** Signs access tokens (HMAC-SHA-256). */
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    /** Encrypts secrets stored in the database, such as TOTP keys (AES-256-GCM). */
    ENCRYPTION_KEY: base64Key32,
    /** The web dashboard's address: used in email links and as the only origin allowed to use the refresh cookie. */
    WEB_APP_URL: z.url({ protocol: /^https?$/ }),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().min(3),

    /** S3-compatible storage for photos and import files (SeaweedFS locally; the host chosen under D-16 later). */
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
    /** Address browsers use for short-lived download links, if different from S3_ENDPOINT. */
    S3_PUBLIC_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    /** Run background jobs inside the API process too (development, tests, small installations). */
    RUN_JOBS_IN_API: z.enum(['true', 'false']).default('false'),
    /**
     * Repeating jobs (the class-monitoring sweep). On wherever jobs run; the API's automated tests
     * switch it off and run the sweep themselves, so a sweep never lands in the middle of a test.
     */
    RUN_SCHEDULED_JOBS: z.enum(['true', 'false']).default('true'),
    /** First retry delay for a failed job; later retries wait longer (exponential). */
    JOB_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(600_000).default(5000),

    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid bucket name'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const keyText = Buffer.from(env.ENCRYPTION_KEY, 'base64').toString('latin1');
    for (const [name, value] of [
      ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
      ['ENCRYPTION_KEY', keyText],
      ['S3_SECRET_KEY', env.S3_SECRET_KEY],
    ] as const) {
      if (value.includes(LOCAL_ONLY_MARKER)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'is the local example value; set a real secret',
        });
      }
    }
    if (!env.WEB_APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['WEB_APP_URL'], message: 'must use https in production' });
    }
  });

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

export interface StorageConfig {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/**
 * Validated, typed configuration. Built once at start-up from environment variables; the app refuses to
 * start if anything is missing or malformed, rather than failing later in the middle of a request.
 */
export class AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly trustProxyHops: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly institutionTimezone: string;
  readonly jwtAccessSecret: Uint8Array;
  readonly encryptionKey: Buffer;
  readonly webAppUrl: string;
  readonly webAppOrigin: string;
  readonly smtp: SmtpConfig;
  readonly storage: StorageConfig;
  readonly runJobsInApi: boolean;
  readonly jobRetryDelayMs: number;
  readonly runScheduledJobs: boolean;

  private constructor(env: z.infer<typeof EnvSchema>) {
    this.nodeEnv = env.NODE_ENV;
    this.port = env.PORT;
    this.trustProxyHops = env.TRUST_PROXY_HOPS;
    this.logLevel = env.LOG_LEVEL;
    this.databaseUrl = env.DATABASE_URL;
    this.redisUrl = env.REDIS_URL;
    this.institutionTimezone = env.INSTITUTION_TIMEZONE;
    this.jwtAccessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.encryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');
    this.webAppUrl = env.WEB_APP_URL.replace(/\/$/, '');
    this.webAppOrigin = new URL(env.WEB_APP_URL).origin;
    this.smtp = {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || undefined,
      password: env.SMTP_PASSWORD || undefined,
      from: env.SMTP_FROM,
    };
    this.runJobsInApi = env.RUN_JOBS_IN_API === 'true';
    this.jobRetryDelayMs = env.JOB_RETRY_DELAY_MS;
    this.runScheduledJobs = env.RUN_SCHEDULED_JOBS === 'true';
    this.storage = {
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      bucket: env.S3_BUCKET,
    };
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
