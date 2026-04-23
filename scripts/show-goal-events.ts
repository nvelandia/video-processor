#!/usr/bin/env ts-node
/**
 * Muestra los eventos de gol de un job en formato legible.
 * Uso: npx ts-node scripts/show-goal-events.ts <jobId>
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const TABLE  = 'video-processor-dev-goals-events';
const REGION = 'us-east-1';

const SOURCES = ['crowd_noise', 'keyword', 'visual'] as const;

const dynamo = new DynamoDBClient({ region: REGION });

function msToTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes  = Math.floor(totalSec / 60);
  const seconds  = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function queryBySource(jobId: string, source: string): Promise<any[]> {
  const results: any[] = [];
  let lastKey: any;

  do {
    const resp = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'jobId-source-index',
      KeyConditionExpression: 'jobId = :jid AND #src = :src',
      ExpressionAttributeNames:  { '#src': 'source' },
      ExpressionAttributeValues: {
        ':jid': { S: jobId },
        ':src': { S: source },
      },
      ExclusiveStartKey: lastKey,
    }));
    if (resp.Items) results.push(...resp.Items.map(i => unmarshall(i)));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return results.sort((a, b) => a.timestampMs - b.timestampMs);
}

function printTable(events: any[], source: string) {
  console.log(`\n── ${source.toUpperCase().replace('_', ' ')} (${events.length} eventos) ─────────────────────`);
  if (events.length === 0) {
    console.log('   (ninguno)');
    return;
  }
  console.log('   tiempo   confidence   chunkIndex');
  console.log('   ──────   ──────────   ──────────');
  for (const e of events) {
    const time  = msToTime(e.timestampMs);
    const conf  = (e.confidence as number).toFixed(3);
    const chunk = String(e.chunkIndex ?? '-').padStart(2);
    console.log(`   ${time}    ${conf.padStart(10)}   ${chunk}`);
  }
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Uso: npx ts-node scripts/show-goal-events.ts <jobId>');
    process.exit(1);
  }

  console.log(`\nJobId: ${jobId}`);
  console.log(`Tabla: ${TABLE}\n`);

  const [crowdEvents, keywordEvents, visualEvents] = await Promise.all(
    SOURCES.map(s => queryBySource(jobId, s)),
  );

  printTable(crowdEvents,   'crowd_noise');
  printTable(keywordEvents, 'keyword');
  printTable(visualEvents,  'visual');

  // Resumen
  console.log('\n── RESUMEN ───────────────────────────────────────');
  console.log(`   crowd_noise : ${crowdEvents.length}`);
  console.log(`   keyword     : ${keywordEvents.length}`);
  console.log(`   visual      : ${visualEvents.length}`);
  console.log(`   TOTAL       : ${crowdEvents.length + keywordEvents.length + visualEvents.length}`);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
