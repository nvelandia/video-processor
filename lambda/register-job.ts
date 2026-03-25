import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TOTAL_STEPS = 10;

export const handler = async (event: { bucket: string; key: string }) => {
  const { bucket, key } = event;
  const fileName = key.split('/').pop() || key;
  const videoId = randomUUID();
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: process.env.TABLE_NAME as string,
    Item: {
      videoId,
      fileName,
      s3Key: key,
      status: 'IN_PROGRESS',
      currentStep: 1,
      totalSteps: TOTAL_STEPS,
      stepName: 'GENERATING_QUALITIES',
      createdAt: now,
      updatedAt: now,
    },
  }));

  console.log(`Job registrado. videoId: ${videoId}, archivo: ${fileName}`);

  return { bucket, key, videoId };
};
