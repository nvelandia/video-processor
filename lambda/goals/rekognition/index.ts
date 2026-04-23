import {
  RekognitionClient,
  StartLabelDetectionCommand,
  GetLabelDetectionCommand,
  LabelDetection,
} from '@aws-sdk/client-rekognition';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

import { writeGoalEvent, writeTaskToken } from '../shared/goal-event-writer';

const rekognition = new RekognitionClient({});
const sfn         = new SFNClient({});
const dynamo      = new DynamoDBClient({});

const GOAL_LABELS = new Set(['Celebration', 'Cheering', 'Sport', 'Soccer', 'Football', 'Crowd']);
const GROUP_GAP_MS = 3000;

// ──────────────────────────────────────────────────────────────────────────────
// launch: invocado por Step Functions WAIT_FOR_TASK_TOKEN
// Ejecución única sobre el video completo (fuera del Map state)
// ──────────────────────────────────────────────────────────────────────────────
export interface LaunchEvent {
  jobId:     string;
  inputKey:  string;
  taskToken: string;
}

export const launch = async (event: LaunchEvent): Promise<void> => {
  const { jobId, inputKey, taskToken } = event;

  // chunkIndex=0 porque es ejecución única
  await writeTaskToken(jobId, 0, { service: 'rekognition', taskToken });

  const { bucket, key } = parseS3Uri(inputKey);

  const resp = await rekognition.send(new StartLabelDetectionCommand({
    Video:              { S3Object: { Bucket: bucket, Name: key } },
    MinConfidence:      70,
    ClientRequestToken: `goals__${jobId}__full`,
    NotificationChannel: {
      SNSTopicArn: process.env.REKOGNITION_SNS_TOPIC as string,
      RoleArn:     process.env.REKOGNITION_ROLE_ARN  as string,
    },
  }));

  console.log(`rekognition launched job=${jobId} rekognitionJobId=${resp.JobId}`);
};

// ──────────────────────────────────────────────────────────────────────────────
// callback: invocado por EventBridge (Rekognition Video Analysis State Change)
// ──────────────────────────────────────────────────────────────────────────────
export const callback = async (event: any): Promise<void> => {
  const token = event.detail?.ClientRequestToken as string | undefined;
  if (!token?.startsWith('goals__')) return;

  const match = token.match(/^goals__(.+)__full$/);
  if (!match) {
    console.error(`unexpected client request token: ${token}`);
    return;
  }
  const jobId = match[1];

  const taskToken = await getTaskToken(jobId, 0, 'rekognition');
  if (!taskToken) {
    console.error(`no task token for rekognition job=${jobId}`);
    return;
  }

  const status = event.detail?.Status as string;
  if (status !== 'SUCCEEDED') {
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'RekognitionFailed',
      cause: `Status: ${status}`,
    }));
    return;
  }

  const rekognitionJobId = event.detail?.JobId as string;
  const allLabels = await getAllLabelDetections(rekognitionJobId);
  const relevant  = allLabels.filter(l => l.Label?.Name && GOAL_LABELS.has(l.Label.Name));

  // Agrupar contiguas por timestamp: detecciones a <3s de distancia = mismo momento
  const groups = groupContiguous(relevant, GROUP_GAP_MS);

  for (const group of groups) {
    const first     = group[0];
    const absoluteMs = first.Timestamp ?? 0;
    await writeGoalEvent(jobId, 0, {
      source:      'visual',
      timestampMs: absoluteMs,
      confidence:  (first.Label?.Confidence ?? 0) / 100,
    });
  }

  console.log(`rekognition callback job=${jobId} relevant=${relevant.length} groups=${groups.length}`);

  await sfn.send(new SendTaskSuccessCommand({
    taskToken,
    output: JSON.stringify({ visuals: groups.length }),
  }));
};

// ──────────────────────────────────────────────────────────────────────────────

async function getAllLabelDetections(rekognitionJobId: string): Promise<LabelDetection[]> {
  const results: LabelDetection[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await rekognition.send(new GetLabelDetectionCommand({
      JobId:      rekognitionJobId,
      MaxResults: 1000,
      NextToken:  nextToken,
    }));
    if (resp.Labels) results.push(...resp.Labels);
    nextToken = resp.NextToken;
  } while (nextToken);
  return results;
}

function groupContiguous(items: LabelDetection[], gapMs: number): LabelDetection[][] {
  const sorted = [...items].sort((a, b) => (a.Timestamp ?? 0) - (b.Timestamp ?? 0));
  const groups: LabelDetection[][] = [];
  let current:  LabelDetection[]   = [];
  let lastTs = -Infinity;

  for (const item of sorted) {
    const ts = item.Timestamp ?? 0;
    if (ts - lastTs > gapMs && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(item);
    lastTs = ts;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function getTaskToken(jobId: string, chunkIndex: number, service: string): Promise<string | undefined> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: process.env.GOALS_EVENTS_TABLE as string,
    Key:       marshall({ jobId, eventId: `task_token#${service}#${chunkIndex}` }),
  }));
  if (!result.Item) return undefined;
  return (unmarshall(result.Item) as any).taskToken;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (uri.startsWith('s3://')) {
    const [, , bucket, ...rest] = uri.split('/');
    return { bucket, key: rest.join('/') };
  }
  return { bucket: process.env.BUCKET as string, key: uri };
}
