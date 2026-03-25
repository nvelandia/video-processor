import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({});

const MODEL_ID = process.env.PEGASUS_MODEL_ID as string;

export const handler = async (event: { bucket: string; key: string; videoId: string }) => {
  const { bucket, key, videoId } = event;

  const s3Uri = `s3://${bucket}/${key}`;

  const requestBody = {
    mediaSource: {
      s3Location: {
        uri: s3Uri,
        bucketOwner: process.env.BUCKET_OWNER as string,
      },
    },
    inputPrompt: "Identify all goal moments in this soccer match. For each goal, provide the exact timestamp in seconds and a brief description.",
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    body: JSON.stringify(requestBody),
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await bedrockClient.send(command);
  const result = JSON.parse(Buffer.from(response.body).toString("utf-8"));

  console.log(`Twelve Labs Pegasus completó el análisis para videoId: ${videoId}`, result);

  return { bucket, key, videoId, goalTimestamps: result };
};