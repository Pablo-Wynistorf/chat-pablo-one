/**
 * Shared AWS wiring for the indexer scripts.
 *
 * Credentials come from `fromNodeProviderChain()` (works with `aws sso login`,
 * env vars, shared config, or IMDS). If `AWS_ROLE_ARN` is set, we additionally
 * assume that least-privilege role so the indexer runs with exactly the scoped
 * S3 Vectors + Bedrock permissions Terraform created.
 */
import { fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { config as loadDotenv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Both the indexer and the web app read the same file: web/.env.local.
// override:true so .env.local wins over any ambient AWS_REGION in the shell.
//
// Terraform sets INDEXER_SKIP_DOTENV=1 when it drives the indexer during
// `apply`: it passes the bucket/index it just created directly in the
// environment, and a stale .env.local pointing at a previous bucket would
// otherwise silently win and load the vectors into the wrong place.
if (process.env.INDEXER_SKIP_DOTENV !== "1") {
  loadDotenv({ path: join(HERE, "..", "..", "web", ".env.local"), override: true });
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Run:\n  cd terraform && terraform output -raw env_local > ../web/.env.local`,
    );
  }
  return v;
}

export const region = process.env.AWS_REGION ?? "eu-central-1";

export function credentials() {
  const base = fromNodeProviderChain();
  const roleArn = process.env.AWS_ROLE_ARN;
  if (roleArn && roleArn.trim() !== "") {
    return fromTemporaryCredentials({
      masterCredentials: base,
      params: {
        RoleArn: roleArn,
        RoleSessionName: "pablo-one-poc-indexer",
        DurationSeconds: 3600,
      },
      clientConfig: { region },
    });
  }
  return base;
}
