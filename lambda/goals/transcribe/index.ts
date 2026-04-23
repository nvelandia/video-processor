import ffmpeg from 'fluent-ffmpeg';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  LanguageCode,
} from '@aws-sdk/client-transcribe';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

import { writeGoalEvent, writeTaskToken } from '../shared/goal-event-writer';

ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');

const s3         = new S3Client({});
const transcribe = new TranscribeClient({});
const sfn        = new SFNClient({});
const dynamo     = new DynamoDBClient({});

const CHUNK_S = 600;
const KEYWORDS  = (process.env.GOAL_KEYWORDS ?? 'gol,golazo,goool,goal')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// NEGATIVES usa "|" como separador porque las frases tienen espacios (p.ej. "no fue")
const NEGATIVES = (process.env.GOAL_NEGATIVES ?? 'no fue|no es|no hubo|anulado|fuera de juego')
  .split('|').map(s => s.trim().toLowerCase()).filter(Boolean);
const LANGUAGE  = (process.env.TRANSCRIBE_LANGUAGE ?? 'es-ES') as LanguageCode;

// ──────────────────────────────────────────────────────────────────────────────
// launch: invocado por Step Functions WAIT_FOR_TASK_TOKEN
// Extrae audio del chunk → S3 tmp/ → StartTranscriptionJob
// ──────────────────────────────────────────────────────────────────────────────
export interface LaunchEvent {
  taskToken:  string;
  jobId:      string;
  chunkIndex: number;
  inputKey:   string;
  startS:     number;
  endS:       number;
  offsetMs:   number;
}

export const launch = async (event: LaunchEvent): Promise<void> => {
  const { taskToken, jobId, chunkIndex, inputKey, startS, endS } = event;

  await writeTaskToken(jobId, chunkIndex, { service: 'transcribe', taskToken });

  const { bucket: srcBucket, key: srcKey } = parseS3Uri(inputKey);
  const bucket   = process.env.BUCKET as string;
  const audioKey = `tmp/${jobId}/audio-chunk-${chunkIndex}.mp3`;

  const inputUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }),
    { expiresIn: 3600 },
  );

  const audioBuffer = await extractAudioChunk(inputUrl, startS, endS);
  await s3.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         audioKey,
    Body:        audioBuffer,
    ContentType: 'audio/mpeg',
  }));

  await transcribe.send(new StartTranscriptionJobCommand({
    TranscriptionJobName: `goals__${jobId}__chunk${chunkIndex}`,
    Media:                { MediaFileUri: `s3://${bucket}/${audioKey}` },
    MediaFormat:          'mp3',
    LanguageCode:         LANGUAGE,
    Settings:             { ShowSpeakerLabels: false },
  }));

  console.log(`transcribe launched job=${jobId} chunk=${chunkIndex} audio=${audioKey}`);
};

// ──────────────────────────────────────────────────────────────────────────────
// callback: invocado por EventBridge cuando Transcribe termina
// ──────────────────────────────────────────────────────────────────────────────
export const callback = async (event: any): Promise<void> => {
  const jobName = event.detail?.TranscriptionJobName as string | undefined;
  if (!jobName?.startsWith('goals__')) return;

  const match = jobName.match(/^goals__(.+)__chunk(\d+)$/);
  if (!match) {
    console.error(`unexpected transcribe job name: ${jobName}`);
    return;
  }
  const jobId      = match[1];
  const chunkIndex = parseInt(match[2], 10);
  const offsetMs   = chunkIndex * CHUNK_S * 1000;

  const taskToken = await getTaskToken(jobId, chunkIndex, 'transcribe');
  if (!taskToken) {
    console.error(`no task token for job=${jobId} chunk=${chunkIndex}`);
    return;
  }

  const status = event.detail?.TranscriptionJobStatus as string;
  if (status === 'FAILED') {
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'TranscribeFailed',
      cause: event.detail?.FailureReason ?? 'unknown',
    }));
    return;
  }

  // El evento de EventBridge no incluye TranscriptFileUri — hay que consultarlo
  const getResp = await transcribe.send(new GetTranscriptionJobCommand({
    TranscriptionJobName: jobName,
  }));
  const transcriptUri = getResp.TranscriptionJob?.Transcript?.TranscriptFileUri;
  if (!transcriptUri) {
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'NoTranscriptUri',
      cause: `TranscriptionJob sin TranscriptFileUri para ${jobName}`,
    }));
    return;
  }

  const transcript = await fetchJson(transcriptUri);
  const items      = transcript.results?.items ?? [];

  let matched = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'pronunciation') continue;
    const word = item.alternatives?.[0]?.content?.toLowerCase() ?? '';
    if (!KEYWORDS.includes(word)) continue;

    // Contexto: las 3 palabras anteriores (saltando puntuación)
    const prevWords: string[] = [];
    for (let j = i - 1; j >= 0 && prevWords.length < 3; j--) {
      if (items[j].type === 'pronunciation') {
        prevWords.unshift(items[j].alternatives?.[0]?.content?.toLowerCase() ?? '');
      }
    }
    const context = prevWords.join(' ');
    if (NEGATIVES.some(neg => context.includes(neg))) continue;

    const absoluteMs = Math.round(parseFloat(item.start_time) * 1000) + offsetMs;
    await writeGoalEvent(jobId, chunkIndex, {
      source:      'keyword',
      timestampMs: absoluteMs,
      confidence:  parseFloat(item.alternatives?.[0]?.confidence ?? '0'),
    });
    matched++;
  }

  console.log(`transcribe callback job=${jobId} chunk=${chunkIndex} keywords=${matched}`);

  await sfn.send(new SendTaskSuccessCommand({
    taskToken,
    output: JSON.stringify({ keywords: matched }),
  }));
};

// ──────────────────────────────────────────────────────────────────────────────

function extractAudioChunk(inputUrl: string, startS: number, endS: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cmd = ffmpeg(inputUrl)
      .seekInput(startS)
      .duration(endS - startS)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .format('mp3')
      .on('error', reject);

    const stream = cmd.pipe();
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function getTaskToken(jobId: string, chunkIndex: number, service: string): Promise<string | undefined> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: process.env.GOALS_EVENTS_TABLE as string,
    Key:       marshall({ jobId, eventId: `task_token#${service}#${chunkIndex}` }),
  }));
  if (!result.Item) return undefined;
  return (unmarshall(result.Item) as any).taskToken;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch transcript failed: ${res.status}`);
  return res.json();
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (uri.startsWith('s3://')) {
    const [, , bucket, ...rest] = uri.split('/');
    return { bucket, key: rest.join('/') };
  }
  return { bucket: process.env.BUCKET as string, key: uri };
}
