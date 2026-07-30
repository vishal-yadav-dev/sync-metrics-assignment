import "dotenv/config";
import { z } from "zod";

const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const EnvSchema = z.object({
  // Injected by the host (Render); 3000 locally. Validated here so a bad value fails at
  // boot rather than silently binding port 0.
  PORT: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().max(65535).default(3000),
  ),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  STRIPE_SECRET_KEY: z.preprocess(blankToUndefined, z.string().min(1)),

  HUBSPOT_TOKEN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  GOOGLE_CLIENT_EMAIL: z.preprocess(blankToUndefined, z.email().optional()),
  // Unset means the service account's own (empty) primary calendar.
  GOOGLE_CALENDAR_ID: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  GOOGLE_PRIVATE_KEY: z
    .preprocess(blankToUndefined, z.string().min(1).optional())
    .transform((key) => key?.replace(/\\n/g, "\n")),
  STRIPE_WEBHOOK_SECRET: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment. Fix these before starting:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;

// Boot no longer guarantees the optional vars, so call sites that need one fail here.
export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value == null) {
    throw new Error(`${key} is required for this operation but is not set`);
  }
  return value as NonNullable<Env[K]>;
}
