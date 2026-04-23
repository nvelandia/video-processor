import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const dynamo = new DynamoDBClient({});
const ddb    = DynamoDBDocumentClient.from(dynamo);
const cw     = new CloudWatchClient({});

const TABLE         = process.env.GOALS_EVENTS_TABLE as string;
const JOBS_TABLE    = process.env.JOBS_TABLE         as string;
const METRICS_NS    = process.env.METRICS_NAMESPACE ?? 'VideoProcessor/Goals';

const WINDOW_MS         = parseInt(process.env.WINDOW_MS          ?? '8000',  10);
const REACTION_DELAY_MS = parseInt(process.env.REACTION_DELAY_MS  ?? '2000',  10);
const CLIP_BEFORE_MS    = parseInt(process.env.CLIP_BEFORE_MS     ?? '5000',  10);
const CLIP_AFTER_MS     = parseInt(process.env.CLIP_AFTER_MS      ?? '8000',  10);
const MIN_GAP_MS        = parseInt(process.env.MIN_GAP_MS         ?? '15000', 10);
const MIN_SCORE         = parseFloat(process.env.MIN_SCORE        ?? '0.5');

// Un keyword "GOL" es evidencia mucho más fuerte que un label visual de "Crowd",
// que puede dispararse en un córner o tiro libre.
const VALENCIA_WEIGHTS: Record<string, number> = {
  keyword: 1.0,
  visual:  0.4,
};
const DEFAULT_WEIGHT = 0.3;

interface GoalEventItem {
  jobId:       string;
  eventId:     string;
  source:      'crowd_noise' | 'keyword' | 'visual';
  timestampMs: number;
  confidence:  number;
  chunkIndex:  number;
}

export interface GoalClip {
  goalMs:      number;
  clipStartMs: number;
  clipEndMs:   number;
  confirmedBy: string[];
  score:       number;
}

export const handler = async (event: { jobId: string }): Promise<{ goals: GoalClip[] }> => {
  const { jobId } = event;

  const [crowdEvents, keywordEvents, visualEvents] = await Promise.all([
    queryAllEventsBySource(jobId, 'crowd_noise'),
    queryAllEventsBySource(jobId, 'keyword'),
    queryAllEventsBySource(jobId, 'visual'),
  ]);

  const confirmers = [...keywordEvents, ...visualEvents]
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const anchors = [...crowdEvents].sort((a, b) => a.timestampMs - b.timestampMs);

  // Anchor+Confirm con sliding window
  const confirmed: GoalClip[] = [];
  let windowStart = 0;

  for (const anchor of anchors) {
    const lower = anchor.timestampMs - WINDOW_MS;
    const upper = anchor.timestampMs + WINDOW_MS;

    while (windowStart < confirmers.length && confirmers[windowStart].timestampMs < lower) {
      windowStart++;
    }

    let score = 0;
    const confirming: string[] = [];
    for (let j = windowStart; j < confirmers.length && confirmers[j].timestampMs <= upper; j++) {
      const e = confirmers[j];
      const weight = VALENCIA_WEIGHTS[e.source] ?? DEFAULT_WEIGHT;
      score += weight * e.confidence;
      confirming.push(e.source);
    }

    if (score < MIN_SCORE) continue;

    const goalMs = anchor.timestampMs - REACTION_DELAY_MS;
    confirmed.push({
      goalMs,
      clipStartMs: Math.max(0, goalMs - CLIP_BEFORE_MS),
      clipEndMs:   anchor.timestampMs + CLIP_AFTER_MS,
      confirmedBy: confirming,
      score,
    });
  }

  // Deduplicar: dos anchors a menos de MIN_GAP_MS = mismo gol capturado dos veces
  // (ocurre cuando un gol cae en el overlap entre dos chunks). Se queda el de mayor score.
  const deduped = confirmed
    .sort((a, b) => a.goalMs - b.goalMs)
    .reduce<GoalClip[]>((acc, goal) => {
      const last = acc[acc.length - 1];
      if (last && (goal.goalMs - last.goalMs) < MIN_GAP_MS) {
        if (goal.score > last.score) acc[acc.length - 1] = goal;
        return acc;
      }
      acc.push(goal);
      return acc;
    }, []);

  await emitFusionMetrics(jobId, {
    anchorsDetected:  anchors.length,
    keywordsDetected: keywordEvents.length,
    visualsDetected:  visualEvents.length,
    confirmedGoals:   deduped.length,
    discardedAnchors: anchors.length - confirmed.length,
  });

  await ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: 'SET goalsCount = :c',
    ExpressionAttributeValues: { ':c': deduped.length },
  }));

  console.log(
    `fusion job=${jobId} anchors=${anchors.length} keywords=${keywordEvents.length} ` +
    `visuals=${visualEvents.length} confirmed=${confirmed.length} deduped=${deduped.length}`,
  );

  return { goals: deduped };
};

async function queryAllEventsBySource(jobId: string, source: string): Promise<GoalEventItem[]> {
  const results: GoalEventItem[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const resp = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'jobId-source-index',
      KeyConditionExpression: 'jobId = :jid AND #src = :src',
      ExpressionAttributeNames:  { '#src': 'source' },
      ExpressionAttributeValues: marshall({ ':jid': jobId, ':src': source }),
      ExclusiveStartKey: lastKey,
    }));
    if (resp.Items) {
      results.push(...resp.Items.map(i => unmarshall(i) as GoalEventItem));
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return results;
}

interface FusionMetrics {
  anchorsDetected:  number;
  keywordsDetected: number;
  visualsDetected:  number;
  confirmedGoals:   number;
  discardedAnchors: number;
}

async function emitFusionMetrics(jobId: string, m: FusionMetrics): Promise<void> {
  const timestamp  = new Date();
  const dimensions = [{ Name: 'JobId', Value: jobId }];
  const falsePositiveRatio = m.anchorsDetected > 0
    ? m.discardedAnchors / m.anchorsDetected
    : 0;

  await cw.send(new PutMetricDataCommand({
    Namespace: METRICS_NS,
    MetricData: [
      { MetricName: 'AnchorsDetected',    Value: m.anchorsDetected,  Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'KeywordsDetected',   Value: m.keywordsDetected, Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'VisualsDetected',    Value: m.visualsDetected,  Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'ConfirmedGoals',     Value: m.confirmedGoals,   Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'DiscardedAnchors',   Value: m.discardedAnchors, Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'FalsePositiveRatio', Value: falsePositiveRatio, Unit: 'None',  Timestamp: timestamp, Dimensions: dimensions },
    ],
  }));
}
