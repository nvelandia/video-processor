import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

export const handler = async (event: any): Promise<void> => {
  const record = event.Records[0];
  const bucketName = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  const filename = key.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
  const jobId = `${filename}-${randomUUID()}`;
  const bucket = process.env.BUCKET as string;
  const inputKey = `s3://${bucketName}/${key}`;
  const outputVideo = `s3://${bucket}/output/${jobId}/`;
  const createdAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 días

  await dynamo.send(new PutCommand({
    TableName: process.env.TABLE_NAME as string,
    Item: {
      jobId,
      qualitiesStatus: 'PENDING',
      highlightsStatus: 'PEGASUS',
      outputVideo,
      inputKey,
      createdAt,
      ttl,
    },
  }));

  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN as string,
    name: jobId,
    input: JSON.stringify({ jobId, inputKey, outputVideo }),
  }));

  console.log(`Job iniciado: jobId=${jobId}, inputKey=${inputKey}, outputVideo=${outputVideo}`);
};
