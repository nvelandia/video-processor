import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const bedrock = new BedrockRuntimeClient({});
const s3     = new S3Client({});
const sfn    = new SFNClient({});

const SPLIT_THRESHOLD_SECS = 3600; // videos > 1 hora se dividen en 3 partes

interface MediaConvertClipping { StartTimecode: string; EndTimecode: string; }
interface Goal { start: string; goal_moment?: string; end: string; description?: string; }

// ── Tiempo ────────────────────────────────────────────────────────────────────

function hhmmssToSecs(hhmmss: string): number {
  const parts = hhmmss.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1]; // fallback MM:SS
  throw new Error(`Invalid timestamp format: ${hhmmss}`);
}

function secsToHhmmss(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function secsToTimecode(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:00`;
}

// ── S3 helpers ────────────────────────────────────────────────────────────────

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const rest = uri.replace('s3://', '');
  const idx  = rest.indexOf('/');
  return { bucket: rest.slice(0, idx), key: rest.slice(idx + 1) };
}

async function downloadFromS3(bucket: string, key: string, localPath: string): Promise<void> {
  console.log(`Downloading s3://${bucket}/${key}...`);
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(resp.Body as Readable, fs.createWriteStream(localPath));
  console.log(`Downloaded: ${(fs.statSync(localPath).size / 1024 / 1024).toFixed(0)} MB`);
}

async function uploadToS3(bucket: string, key: string, localPath: string): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: fs.createReadStream(localPath) },
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
  });
  await upload.done();
  console.log(`Uploaded: s3://${bucket}/${key}`);
}

async function deleteFromS3(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ── Duración del video (ffprobe via presigned URL, sin descargar el archivo) ──

async function getVideoDurationSecs(bucket: string, key: string): Promise<number> {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
  const result = spawnSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', url]);
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr.toString().slice(0, 300)}`);
  const streams: Array<{ codec_type: string; duration?: string }> = JSON.parse(result.stdout.toString()).streams;
  const video = streams.find(s => s.codec_type === 'video');
  if (!video?.duration) throw new Error('Could not read video duration');
  return Math.floor(parseFloat(video.duration));
}

// ── Bedrock ───────────────────────────────────────────────────────────────────

function buildPrompt(partDurationSecs: number): string {
  const dur = secsToHhmmss(partDurationSecs);
  return `You are an expert soccer video analyst. Your objective is to detect EVERY single goal scored in this video. Missing a goal is a critical failure.
A goal is ONLY when the ball fully enters the net, the referee validates it and players celebrate. Do NOT include near misses, shots on goal, saves, disallowed goals, or replays.

CRITICAL RULES:
- This video is ${dur} long. ALL timestamps MUST be between 00:00:00 and ${dur}.
- Timestamps MUST reflect the actual position in THIS video file, NOT the match clock or scoreboard.
- Do NOT invent goals. Only report goals you actually see happening in the video.

For each goal return:
- "start": 10 seconds before the ball enters the net (HH:MM:SS format)
- "goal_moment": the exact moment the ball crosses the goal line (HH:MM:SS format)
- "end": 10 seconds after goal_moment (HH:MM:SS format)
- "description": brief description of the goal (who scored, how)

ALL timestamps MUST be in HH:MM:SS format (e.g. 00:12:15 for 12 minutes and 15 seconds into the video).

Respond ONLY with a JSON array. No text outside the JSON.
Example: [{"start":"00:12:10","goal_moment":"00:12:20","end":"00:12:30","description":"Header goal from corner kick"}]
If no goals: []`;
}

async function invokeBedrock(s3Uri: string, accountId: string, modelId: string, partDurationSecs: number): Promise<Goal[]> {
  const prompt = buildPrompt(partDurationSecs);
  console.log(`[Bedrock prompt] Video duration=${partDurationSecs}s, max timestamp=${secsToHhmmss(partDurationSecs)}`);

  const body = JSON.stringify({
    mediaSource: { s3Location: { uri: s3Uri, bucketOwner: accountId } },
    inputPrompt: prompt,
  });

  const response = await bedrock.send(new InvokeModelCommand({
    modelId,
    body: new TextEncoder().encode(body),
    contentType: 'application/json',
    accept: 'application/json',
  }));

  const rawString  = new TextDecoder().decode(response.body);
  console.log(`[Bedrock RAW response] ${rawString.slice(0, 2000)}`);

  const parsed     = JSON.parse(rawString);
  const textContent: string =
    typeof parsed.message === 'string' ? parsed.message :
    typeof parsed.output  === 'string' ? parsed.output  :
    rawString;

  console.log(`[Bedrock parsed text] ${textContent.slice(0, 2000)}`);

  const jsonMatch = textContent.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in Bedrock response: ${textContent.slice(0, 500)}`);

  const goals = JSON.parse(jsonMatch[0]) as Goal[];
  console.log(`[Bedrock goals found] ${JSON.stringify(goals, null, 2)}`);
  return goals;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const taskToken   = process.env.TASK_TOKEN!;
  const jobId       = process.env.JOB_ID!;
  const inputKey    = process.env.INPUT_KEY!;
  const modelId     = process.env.BEDROCK_MODEL_ID!;
  const accountId   = process.env.ACCOUNT_ID!;

  const { bucket, key } = parseS3Uri(inputKey);

  try {
    const durationSecs = await getVideoDurationSecs(bucket, key);
    console.log(`Duration: ${durationSecs}s (${(durationSecs / 60).toFixed(1)} min)`);

    let allGoals: Goal[] = [];

    if (durationSecs <= SPLIT_THRESHOLD_SECS) {
      // ── Video corto: una sola llamada directa ────────────────────────────────
      console.log('Video <= 1h, calling Bedrock directly');
      allGoals = await invokeBedrock(inputKey, accountId, modelId, durationSecs);

    } else {
      // ── Video largo: dividir en 3 partes con overlap de 2 min ────────────────
      const OVERLAP_SECS = 120; // 2 minutos de overlap entre partes
      const split1 = Math.floor(durationSecs / 3);
      const split2 = Math.floor(2 * durationSecs / 3);
      console.log(`Video > 1h, splitting at ${split1}s and ${split2}s with ${OVERLAP_SECS}s overlap`);

      const localInput = `/tmp/input_${jobId}.mp4`;
      await downloadFromS3(bucket, key, localInput);

      // Cada parte empieza OVERLAP_SECS antes del corte (excepto la primera)
      const parts = [
        { localPath: `/tmp/part0_${jobId}.mp4`, s3Key: `tmp/${jobId}/part0.mp4`, offsetSecs: 0,                          startSecs: 0,                          durationSecs: split1 + OVERLAP_SECS },
        { localPath: `/tmp/part1_${jobId}.mp4`, s3Key: `tmp/${jobId}/part1.mp4`, offsetSecs: split1 - OVERLAP_SECS,       startSecs: split1 - OVERLAP_SECS,       durationSecs: (split2 + OVERLAP_SECS) - (split1 - OVERLAP_SECS) },
        { localPath: `/tmp/part2_${jobId}.mp4`, s3Key: `tmp/${jobId}/part2.mp4`, offsetSecs: split2 - OVERLAP_SECS,       startSecs: split2 - OVERLAP_SECS,       durationSecs: durationSecs - (split2 - OVERLAP_SECS) },
      ];

      // Cortar con ffmpeg — stream copy
      execSync(`ffmpeg -i "${localInput}" -t ${parts[0].durationSecs} -c copy "${parts[0].localPath}" -y`, { stdio: 'inherit' });
      execSync(`ffmpeg -ss ${parts[1].startSecs} -i "${localInput}" -t ${parts[1].durationSecs} -c copy "${parts[1].localPath}" -y`, { stdio: 'inherit' });
      execSync(`ffmpeg -ss ${parts[2].startSecs} -i "${localInput}" -c copy "${parts[2].localPath}" -y`, { stdio: 'inherit' });
      fs.unlinkSync(localInput);

      // Subir las 3 partes en paralelo
      await Promise.all(parts.map(p => uploadToS3(bucket, p.s3Key, p.localPath)));
      parts.forEach(p => fs.unlinkSync(p.localPath));

      // Llamar a Bedrock por cada parte secuencialmente y borrar de S3 al terminar
      for (const part of parts) {
        console.log(`[Split] Processing part offset=${part.offsetSecs}s, partDuration=${part.durationSecs}s`);
        try {
          const partGoals = await invokeBedrock(`s3://${bucket}/${part.s3Key}`, accountId, modelId, part.durationSecs);
          console.log(`[Split] Part offset=${part.offsetSecs}s: ${partGoals.length} goals found`);
          for (const g of partGoals) {
            const goalAbsSecs = hhmmssToSecs(g.goal_moment ?? g.start) + part.offsetSecs;
            allGoals.push({
              start:       secsToHhmmss(hhmmssToSecs(g.start)       + part.offsetSecs),
              goal_moment: g.goal_moment ? secsToHhmmss(hhmmssToSecs(g.goal_moment) + part.offsetSecs) : undefined,
              end:         secsToHhmmss(hhmmssToSecs(g.end)         + part.offsetSecs),
              description: g.description,
              _goalAbsSecs: goalAbsSecs, // para deduplicación
            } as any);
          }
        } finally {
          await deleteFromS3(bucket, part.s3Key);
        }
      }

      // ── Deduplicar goles en zonas de overlap ──────────────────────────────────
      // Dos goles cuyo goal_moment difiera en < 30s se consideran el mismo
      const DEDUP_THRESHOLD_SECS = 30;
      allGoals.sort((a, b) => ((a as any)._goalAbsSecs ?? 0) - ((b as any)._goalAbsSecs ?? 0));
      const deduped: Goal[] = [];
      for (const g of allGoals) {
        const gAbs = (g as any)._goalAbsSecs as number;
        const lastAbs = deduped.length > 0 ? ((deduped[deduped.length - 1] as any)._goalAbsSecs as number) : -Infinity;
        if (gAbs - lastAbs > DEDUP_THRESHOLD_SECS) {
          deduped.push(g);
        } else {
          console.log(`[Dedup] Skipping duplicate goal at ${g.goal_moment ?? g.start} (${g.description}) — too close to previous at ${deduped[deduped.length - 1].goal_moment ?? deduped[deduped.length - 1].start}`);
        }
      }
      // Limpiar campo interno
      deduped.forEach(g => delete (g as any)._goalAbsSecs);
      allGoals = deduped;
      console.log(`[Dedup] ${allGoals.length} unique goals after deduplication`);
    }

    // ── Validar y filtrar timestamps ────────────────────────────────────────────
    console.log(`[Pre-validation] allGoals: ${JSON.stringify(allGoals, null, 2)}`);

    const MIN_CLIP_SECS = 5;
    const MAX_CLIP_SECS = 60;

    const validGoals = allGoals.filter(g => {
      const startSecs = hhmmssToSecs(g.start);
      const endSecs   = hhmmssToSecs(g.end);
      const clipDuration = endSecs - startSecs;

      if (startSecs >= endSecs) {
        console.warn(`[Validation SKIP] start >= end: ${g.start} -> ${g.end} (${g.description})`);
        return false;
      }
      if (clipDuration < MIN_CLIP_SECS) {
        console.warn(`[Validation SKIP] clip too short (${clipDuration}s): ${g.start} -> ${g.end} (${g.description})`);
        return false;
      }
      if (clipDuration > MAX_CLIP_SECS) {
        console.warn(`[Validation SKIP] clip too long (${clipDuration}s): ${g.start} -> ${g.end} (${g.description})`);
        return false;
      }
      if (startSecs > durationSecs || endSecs > durationSecs) {
        console.warn(`[Validation SKIP] timestamp exceeds video duration (${durationSecs}s): ${g.start} -> ${g.end} (${g.description})`);
        return false;
      }

      console.log(`[Validation OK] ${g.start} -> ${g.end} (${clipDuration}s) — ${g.description}`);
      return true;
    });

    console.log(`[Post-validation] ${validGoals.length}/${allGoals.length} clips passed validation`);

    // ── Convertir a MediaConvert timecodes ─────────────────────────────────────
    const timestamps: MediaConvertClipping[] = validGoals.map(g => ({
      StartTimecode: secsToTimecode(hhmmssToSecs(g.start)),
      EndTimecode:   secsToTimecode(hhmmssToSecs(g.end)),
    }));

    console.log(`[MediaConvert timecodes] ${JSON.stringify(timestamps, null, 2)}`);

    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ timestamps, goals: validGoals }),
    }));

  } catch (err) {
    console.error('Error in pegasus task:', err);
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'PegasusFailed',
      cause: String(err),
    }));
    process.exit(1);
  }
}

main();
