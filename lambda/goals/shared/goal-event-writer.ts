import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const TABLE  = process.env.GOALS_EVENTS_TABLE as string;
const TTL_S  = 86400; // 24h

export type GoalSource = 'crowd_noise' | 'keyword' | 'visual';

export interface GoalEvent {
  source:      GoalSource;
  timestampMs: number;
  confidence:  number;
}

export interface TaskTokenEvent {
  service:   'transcribe' | 'rekognition';
  taskToken: string;
}

// eventId canónico: {source}#{timestampMs}#{chunkIndex}
export async function writeGoalEvent(
  jobId: string,
  chunkIndex: number,
  event: GoalEvent,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + TTL_S;
  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      jobId,
      eventId:     `${event.source}#${event.timestampMs}#${chunkIndex}`,
      source:      event.source,
      timestampMs: event.timestampMs,
      confidence:  event.confidence,
      chunkIndex,
      ttl,
    }),
  }));
}

// eventId canónico para task tokens: task_token#{service}#{chunkIndex}
export async function writeTaskToken(
  jobId: string,
  chunkIndex: number,
  event: TaskTokenEvent,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + TTL_S;
  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      jobId,
      eventId:    `task_token#${event.service}#${chunkIndex}`,
      source:     'task_token',
      taskToken:  event.taskToken,
      chunkIndex,
      ttl,
    }),
  }));
}
