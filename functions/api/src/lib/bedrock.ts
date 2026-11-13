import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { awsCredentials, region } from "./aws";

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "amazon.titan-embed-text-v2:0";
const EMBED_DIMENSION = 1024;

const client = new BedrockRuntimeClient({ region, credentials: awsCredentials });

interface TitanResponse {
  embedding: number[];
  inputTextTokenCount: number;
}

/** Embeds a piece of text with Titan Embed Text v2, returning a 1024-dim vector. */
export async function embed(text: string): Promise<number[]> {
  const body = JSON.stringify({
    inputText: text,
    dimensions: EMBED_DIMENSION,
    normalize: true,
  });

  try {
    const res = await client.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body,
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as TitanResponse;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBED_DIMENSION) {
      throw new Error(`Unexpected embedding shape: length ${parsed.embedding?.length}`);
    }
    return parsed.embedding;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "AccessDeniedException" || name === "AccessDenied") {
      throw new Error(
        `Bedrock AccessDeniedException for "${MODEL_ID}" in ${region}. ` +
          `Enable model access: Bedrock console → Model access → Titan Text Embeddings V2.`,
      );
    }
    throw err;
  }
}
