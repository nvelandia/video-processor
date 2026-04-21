import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';
import * as path from 'path';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

export const handler = async (event: any): Promise<void> => {
  const record = event.Records[0];
  const bucketName = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  const rawName = path.basename(key, '.mp4');
  const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const jobId = `${safeName}-${randomUUID()}`;
  const bucket = process.env.BUCKET as string;
  const inputKey = `s3://${bucketName}/${key}`;
  const outputVideo = `s3://${bucket}/output/${jobId}/`;
  const createdAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 días

  try {
    await dynamo.send(new PutCommand({
      TableName: process.env.TABLE_NAME as string,
      Item: {
        jobId,
        qualitiesStatus: 'PENDING',
        outputVideo,
        inputKey,
        createdAt,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(jobId)',
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`Job duplicado ignorado: jobId=${jobId}`);
      return;
    }
    throw err;
  }

  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN as string,
    name: jobId,
    input: JSON.stringify({ jobId, inputKey, outputVideo }),
  }));

  console.log(`Job iniciado: jobId=${jobId}, inputKey=${inputKey}, outputVideo=${outputVideo}`);
};
