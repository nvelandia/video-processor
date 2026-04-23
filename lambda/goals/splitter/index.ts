import ffmpeg from 'fluent-ffmpeg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');
ffmpeg.setFfprobePath('/opt/bin/ffprobe');

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CHUNK_S   = 600; // 10 min por chunk
const OVERLAP_S = 30;  // overlap para no perder goles en bordes

export interface SplitterInput {
  jobId:    string;
  inputKey: string; // formato: s3://bucket/key o key directo
}

export interface Chunk {
  chunkIndex: number;
  jobId:      string;
  inputKey:   string;
  startS:     number; // incluye overlap
  endS:       number;
  offsetMs:   number; // inicio real del chunk SIN overlap (para timestamps absolutos)
  fps:        number;
}

export interface SplitterOutput {
  hasAudio:  boolean;
  chunks:    Chunk[];
  fps:       number;
  durationS: number;
}

export const handler = async (event: SplitterInput): Promise<SplitterOutput> => {
  const { bucket, key } = parseS3Uri(event.inputKey);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 },
  );

  const info = await ffprobeAsync(url);
  const hasAudio = info.streams.some((s: any) => s.codec_type === 'audio');
  const videoStream = info.streams.find((s: any) => s.codec_type === 'video');
  const duration    = parseFloat(info.format.duration as any);
  const fps         = parseFps(videoStream?.r_frame_rate);

  if (!hasAudio) {
    await updateJob(event.jobId, {
      expr: 'SET goalsStatus = :s',
      values: { ':s': 'NO_AUDIO' },
    });
    return { hasAudio: false, chunks: [], fps, durationS: duration };
  }

  const totalChunks = Math.ceil(duration / CHUNK_S);
  const chunks: Chunk[] = Array.from({ length: totalChunks }, (_, i) => ({
    chunkIndex: i,
    jobId:      event.jobId,
    inputKey:   event.inputKey,
    startS:     Math.max(0, i * CHUNK_S - OVERLAP_S),
    endS:       Math.min((i + 1) * CHUNK_S, duration),
    offsetMs:   i * CHUNK_S * 1000,
    fps,
  }));

  await updateJob(event.jobId, {
    expr: 'SET goalsStatus = :s, goalsChunkCount = :c',
    values: { ':s': 'PENDING', ':c': totalChunks },
  });

  return { hasAudio: true, chunks, fps, durationS: duration };
};

function ffprobeAsync(input: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (err, data) => err ? reject(err) : resolve(data));
  });
}

function parseFps(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 30;
  const [num, den] = rFrameRate.split('/').map(Number);
  if (!den) return num || 30;
  return num / den;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (uri.startsWith('s3://')) {
    const [, , bucket, ...rest] = uri.split('/');
    return { bucket, key: rest.join('/') };
  }
  // Si viene solo el key, usar el bucket del env
  return { bucket: process.env.BUCKET as string, key: uri };
}

async function updateJob(
  jobId: string,
  update: { expr: string; values: Record<string, any> },
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: process.env.JOBS_TABLE as string,
    Key: { jobId },
    UpdateExpression: update.expr,
    ExpressionAttributeValues: update.values,
  }));
}
