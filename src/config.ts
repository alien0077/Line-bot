import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TIME_ZONE: z.string().default('Asia/Taipei'),
  APP_BASE_URL: z.string().default('http://localhost:8080'),
  DASHBOARD_PASSWORD: z.string().default('change-me'),
  SESSION_SECRET: z.string().default('dev-session-secret-change-me'),
  LINE_CHANNEL_SECRET: z.string().default(''),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(''),
  ALLOW_UNSIGNED_WEBHOOKS: z.coerce.boolean().default(true),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().default(''),
  GOOGLE_SHEETS_SHEET_NAME: z.string().default('Records'),
  GOOGLE_GROUPS_SHEET_NAME: z.string().default('Groups'),
  GOOGLE_DRIVE_FOLDER_ID: z.string().default(''),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(''),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().default(''),
  USER_HASH_SALT: z.string().default('line-dashboard-dev-salt'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_TEXT_ANALYSIS_ENABLED: z.coerce.boolean().default(true),
  GEMINI_DAILY_LIMIT: z.coerce.number().default(50),
  PUBLIC_RECENT_LIMIT: z.coerce.number().default(10),
  ADMIN_PAGE_SIZE: z.coerce.number().default(100)
});

export const config = envSchema.parse(process.env);

export const isProduction = config.NODE_ENV === 'production';

export function hasGoogleWorkspaceConfig(): boolean {
  return Boolean(
    config.GOOGLE_SHEETS_SPREADSHEET_ID &&
      (config.GOOGLE_SERVICE_ACCOUNT_JSON || config.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

export function hasDriveConfig(): boolean {
  return Boolean(config.GOOGLE_DRIVE_FOLDER_ID && hasGoogleWorkspaceConfig());
}
