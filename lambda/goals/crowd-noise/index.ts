import ffmpeg from 'fluent-ffmpeg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { writeGoalEvent } from '../shared/goal-event-writer';

ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');
ffmpeg.setFfprobePath('/opt/bin/ffprobe');

const s3 = new S3Client({});

const SAMPLE_RATE = 22050;
const WINDOW_S    = 1.0;
const MIN_GAP_S   = 10;
const PERCENTILE  = 90;

export interface ChunkEvent {
  chunkIndex: number;
  jobId:      string;
  inputKey:   string;
  startS:     number;
  endS:       number;
  offsetMs:   number;
}

export const handler = async (event: ChunkEvent): Promise<{ eventsWritten: number }> => {
  try {
    const { bucket, key } = parseS3Uri(event.inputKey);
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 3600 },
    );

    const audio = await extractAudioSegment(url, event.startS, event.endS, SAMPLE_RATE);

    const samplesPerWindow = SAMPLE_RATE * WINDOW_S;
    const energyPerSecond: number[] = [];
    for (let i = 0; i + samplesPerWindow <= audio.length; i += samplesPerWindow) {
      let sumSq = 0;
      for (let j = 0; j < samplesPerWindow; j++) {
        const v = audio[i + j];
        sumSq += v * v;
      }
      energyPerSecond.push(Math.sqrt(sumSq / samplesPerWindow));
    }

    if (energyPerSecond.length === 0) return { eventsWritten: 0 };

    const threshold = percentile(energyPerSecond, PERCENTILE);
    const peaks = findLocalPeaks(energyPerSecond, threshold, MIN_GAP_S);

    for (const peak of peaks) {
      const absoluteMs = Math.round(peak.timeS * 1000) + event.offsetMs;
      await writeGoalEvent(event.jobId, event.chunkIndex, {
        source:      'crowd_noise',
        timestampMs: absoluteMs,
        confidence:  peak.normalizedEnergy,
      });
    }

    console.log(`crowd-noise chunk=${event.chunkIndex} peaks=${peaks.length} threshold=${threshold.toFixed(4)}`);
    return { eventsWritten: peaks.length };
  } catch (err) {
    // Tolerante: si ffmpeg falla (video corrupto, codec raro), no bloquear el pipeline.
    console.error(`crowd-noise failed chunk=${event.chunkIndex} job=${event.jobId}:`, err);
    return { eventsWritten: 0 };
  }
};

// Extrae audio mono f32le y devuelve Float32Array. Samples = SAMPLE_RATE * duración.
function extractAudioSegment(
  url:        string,
  startS:     number,
  endS:       number,
  sampleRate: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const buffers: Buffer[] = [];
    const cmd = ffmpeg(url)
      .seekInput(startS)
      .duration(endS - startS)
      .noVideo()
      .audioFrequency(sampleRate)
      .audioChannels(1)
      .format('f32le')
      .on('error', reject);

    const stream = cmd.pipe();
    stream.on('data', (c: Buffer) => buffers.push(c));
    stream.on('end', () => {
      const buf = Buffer.concat(buffers);
      // Float32Array sobre el ArrayBuffer del Buffer — zero-copy si alignment ok
      const aligned = Buffer.from(buf);
      const floats  = new Float32Array(
        aligned.buffer,
        aligned.byteOffset,
        Math.floor(aligned.byteLength / 4),
      );
      resolve(floats);
    });
    stream.on('error', reject);
  });
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

interface Peak { timeS: number; normalizedEnergy: number; }

function findLocalPeaks(energy: number[], threshold: number, minGapS: number): Peak[] {
  const maxEnergy = Math.max(...energy, 1e-9);
  const peaks: Peak[] = [];
  let lastPeakS = -Infinity;

  for (let i = 0; i < energy.length; i++) {
    if (energy[i] < threshold) continue;
    const prev = energy[i - 1] ?? 0;
    const next = energy[i + 1] ?? 0;
    if (energy[i] < prev || energy[i] < next) continue; // no es máximo local
    if (i - lastPeakS < minGapS) continue;

    peaks.push({ timeS: i, normalizedEnergy: Math.min(1, energy[i] / maxEnergy) });
    lastPeakS = i;
  }
  return peaks;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (uri.startsWith('s3://')) {
    const [, , bucket, ...rest] = uri.split('/');
    return { bucket, key: rest.join('/') };
  }
  return { bucket: process.env.BUCKET as string, key: uri };
}
