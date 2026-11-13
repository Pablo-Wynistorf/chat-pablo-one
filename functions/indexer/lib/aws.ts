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
import { join } from "node:path";

// Local runs read .env.local from this folder (functions/indexer, the npm script
// working directory). override:true so it wins over any ambient AWS_REGION.
//
// The deployed Lambda sets INDEXER_SKIP_DOTENV=1 and gets the bucket/index from
// its Terraform-managed environment, so a stray .env.local can never redirect it.
if (process.env.INDEXER_SKIP_DOTENV !== "1") {
  loadDotenv({ path: join(process.cwd(), ".env.local"), override: true });
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Locally, copy the Terraform env_local output into functions/indexer/.env.local.`,
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
