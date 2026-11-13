// AWS libs stay server-side because only the API route handlers import them;
// client components never do.
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  fromNodeProviderChain,
  fromTemporaryCredentials,
} from "@aws-sdk/credential-providers";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Local development only: load .env.local from the folder the dev server runs in
// (functions/api), with override:true so the Terraform-generated region/bucket
// win over anything exported in the shell. On Lambda the file does not exist and
// configuration comes from the function environment set by Terraform.
const envLocal = join(process.cwd(), ".env.local");
if (existsSync(envLocal)) {
  loadDotenv({ path: envLocal, override: true });
}

export const region = process.env.AWS_REGION ?? "eu-central-1";

/**
 * Base credentials from the node provider chain (SSO / env / shared config /
 * IMDS). If AWS_ROLE_ARN is set we assume that least-privilege dev role so the
 * app runs with exactly the scoped S3 Vectors + Bedrock permissions.
 */
function makeCredentials() {
  const base = fromNodeProviderChain();
  const roleArn = process.env.AWS_ROLE_ARN;
  if (roleArn && roleArn.trim() !== "") {
    return fromTemporaryCredentials({
      masterCredentials: base,
      params: {
        RoleArn: roleArn,
        RoleSessionName: "pablo-one-poc-web",
        DurationSeconds: 3600,
      },
      clientConfig: { region },
    });
  }
  return base;
}

export const awsCredentials = makeCredentials();

export const s3vClient = new S3VectorsClient({ region, credentials: awsCredentials });
