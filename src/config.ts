import { z } from "zod";

const envSchema = z.object({
  // Trim: a stray space/newline from copy-paste makes Pancake reject the key (403, error_code 105).
  PANCAKE_POS_API_KEY: z.string().trim().min(1, "PANCAKE_POS_API_KEY is required"),
  PANCAKE_POS_SHOP_ID: z.string().trim().min(1, "PANCAKE_POS_SHOP_ID is required"),
  PANCAKE_POS_BASE_URL: z
    .string()
    .url()
    .default("https://pos.pages.fm/api/v1"),
  PORT: z.coerce.number().int().positive().default(3000),
  MCP_AUTH_TOKEN: z.string().optional().describe("Bearer token for HTTP transport auth"),
});

export type PancakeConfig = z.infer<typeof envSchema>;

export function loadConfig(
  source: Record<string, unknown> = process.env,
): PancakeConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return result.data;
}
