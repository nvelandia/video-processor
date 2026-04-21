# Goal Detection Branch — Plan de implementación

> Todo el código nuevo es **TypeScript/Node.js 20.x**, igual que el proyecto existente.

---

## Contexto y reglas

El proyecto `video-processor` ya está en producción. Este documento describe únicamente la nueva branch de detección de goles.

**Regla fundamental:** no se modifica la lógica existente de ningún archivo. El único archivo donde se cambia el flujo es `definition.ts`. En otros archivos existentes (`storage.ts`, `eventbridge-rules.ts`, `video-processor-stack.ts`, `lambdas.ts`) solo se agregan líneas nuevas — nunca se reemplaza ni altera código que ya funciona.

La Step Function resultante:
```
RegisterStart (DynamoDB PutItem)   ← sin cambios
  └── Parallel
       ├── Branch A: qualities     ← EXISTENTE, intacta
       └── Branch B: goals         ← NUEVA
```

---

## Bugs encontrados en el proyecto existente

Corregir estos problemas antes de implementar goals.

### BUG-01 — Permiso `s3:PutObject` sobrante en Orchestrator

**Archivo:** `lib/constructs/lambdas.ts` (permisos del Orchestrator)
**Problema:** el Orchestrator solo escribe en DynamoDB e inicia Step Functions. El permiso `s3:PutObject` no tiene uso y viola least-privilege.
**Fix:** eliminar `s3:PutObject` de los permisos del Orchestrator.

---

### BUG-02 — `jobId` frágil con filenames especiales

**Archivo:** `lambda/orchestrator/index.ts`
**Problema:** `jobId = {filename}-{UUIDv4}`. Si el filename tiene espacios, caracteres especiales (`ñ`, `&`, `()`, `+`), el jobId se corrompe como PK de DynamoDB y como prefijo S3.
**Fix:** sanitizar el filename antes de usarlo:

```typescript
// Antes (frágil)
const jobId = `${filename}-${uuidv4()}`;

// Después (robusto)
const rawName  = path.basename(s3Key, '.mp4');
const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const jobId    = `${safeName}-${uuidv4()}`;
```

---

### BUG-03 — No hay idempotencia en el Orchestrator

**Archivo:** `lambda/orchestrator/index.ts`
**Problema:** S3 garantiza entrega at-least-once. Si el evento se dispara dos veces para el mismo archivo, se crean dos jobs duplicados para el mismo video.
**Fix:** usar `ConditionExpression` en el PutItem:

```typescript
await dynamoDB.putItem({
  TableName: process.env.JOBS_TABLE!,
  Item: { /* ... */ },
  ConditionExpression: 'attribute_not_exists(jobId)',
}).catch(err => {
  if (err.name === 'ConditionalCheckFailedException') return; // duplicado, ignorar
  throw err;
});
```

---

### BUG-04 — Timeout de Step Function demasiado ajustado

**Archivo:** `lib/constructs/state-machine.ts`
**Problema:** timeout de 2 horas es igual al caso peor de un partido. Con la branch de goals corriendo en paralelo y videos de 2+ horas, el timeout puede dispararse antes de que lleguen todos los callbacks.
**Fix:** subir el timeout a **4 horas**:

```typescript
timeout: Duration.hours(4),
```

---

## Diseño de la nueva tabla DynamoDB: `goals-events`

Los eventos de señales **no se guardan en la tabla `jobs` existente**. Van a una tabla separada con TTL automático de 24 horas.

**Por qué tabla separada:**
- La tabla `jobs` es operacional. Un partido de 2 horas puede generar 500–2000 eventos de crowd noise, keywords y labels. Eso no pertenece ahí.
- Con TTL de 24h los eventos se limpian solos — no hay basura acumulada, no hace falta código de cleanup.
- Si un job se re-procesa (por fallo o reintento), los eventos viejos ya expiraron. No se mezclan con los nuevos.

**Tabla:** `video-processor-{stage}-goals-events`

| Campo | Tipo | Descripción |
|---|---|---|
| `jobId` | String (PK) | FK a la tabla jobs |
| `eventId` | String (SK) | `{source}#{timestampMs}#{chunkIndex}` |
| `source` | String | `crowd_noise` \| `keyword` \| `visual` \| `task_token` |
| `timestampMs` | Number | Timestamp absoluto desde el inicio del video (ms) |
| `confidence` | Number | Score de confianza 0–1 |
| `chunkIndex` | Number | Para trazabilidad |
| `taskToken` | String | Solo presente cuando `source = task_token` |
| `ttl` | Number | `now + 24h` — limpieza automática |

**GSI:** `jobId-source-index` (PK: `jobId`, SK: `source`) — permite a la Lambda fusion hacer query por señal sin scan.

### Task tokens de chunks en esta misma tabla

Los task tokens de Transcribe y Rekognition se guardan como ítems con `source: "task_token"` en `goals-events`, no como campos en la tabla `jobs`. Esto evita que el ítem de jobs crezca con N campos por chunk (24 task tokens para un video de 2 horas).

**Nota sobre Rekognition:** con la refactorización de Rekognition fuera del Map (ver sección de arquitectura), solo hay un task token de Rekognition por job, no uno por chunk. Igualmente se guarda en `goals-events` por consistencia.

### Campos nuevos en la tabla `jobs` existente

Solo se agregan estos campos al ítem existente:

| Campo | Tipo | Descripción |
|---|---|---|
| `goalsStatus` | String | `PENDING` → `DONE` \| `FAILED` \| `NO_AUDIO` |
| `goalsOutputKey` | String | `output/{jobId}/goals/highlight.mp4` |
| `goalsCount` | Number | Cantidad de goles detectados |
| `goalsChunkCount` | Number | Total de chunks procesados |
| `goalsTaskToken` | String | Task token del estado `LaunchGoalsHighlight` |

---

## Arquitectura de la Branch B: Rekognition fuera del Map

`StartLabelDetection` de Rekognition Video no soporta clips — siempre procesa el archivo completo. Si se ejecuta dentro del Map (una vez por chunk), un partido de 2 horas con 12 chunks dispara 12 invocaciones idénticas sobre el mismo video. Costo multiplicado por 12 sin beneficio.

**Diseño correcto:** Rekognition se ejecuta **una sola vez** como rama paralela al Map, procesando el video completo:

```
VideoSplitter → Choice HasAudio?
  └── Parallel (GoalsProcessing)
       ├── GoalsMap (crowd-noise + Transcribe por chunk)
       │     └── Parallel por chunk (ChunkSignals)
       │           ├── CrowdNoiseAnalysis
       │           └── TranscribeJob (WAIT_FOR_TASK_TOKEN)
       └── RekognitionFullVideo (WAIT_FOR_TASK_TOKEN, video completo, una sola vez)
  └── GoalsFusion
  └── LaunchGoalsHighlight (WAIT_FOR_TASK_TOKEN)
```

La Lambda de callback de Rekognition sigue guardando eventos en `goals-events` con timestamps absolutos, así que la Lambda de Fusion no nota diferencia — simplemente lee todos los eventos `visual` del job.

---

## Lambda Layer: ffmpeg/ffprobe

Las lambdas `splitter`, `crowd-noise` y `transcribe/launch` necesitan binarios de `ffmpeg` y `ffprobe` que **no vienen incluidos** en el runtime de Lambda Node.js 20.x. Se empaquetan como Lambda Layer.

**Layer:** `video-processor-{stage}-ffmpeg-layer`

**Estructura:**
```
layers/
└── ffmpeg/
    └── bin/
        ├── ffmpeg        ← binario estático para linux-x64
        └── ffprobe       ← binario estático para linux-x64
```

**Binarios:** usar los builds estáticos de https://johnvansickle.com/ffmpeg/ (release `linux-amd64`, versión estática). Descomprimir y copiar solo `ffmpeg` y `ffprobe` a `layers/ffmpeg/bin/`.

**CDK construct** (dentro de `goals-lambdas.ts`):
```typescript
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';

const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
  code: lambda.Code.fromAsset(path.join(__dirname, '../../layers/ffmpeg')),
  compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
  compatibleArchitectures: [lambda.Architecture.X86_64],
  description: 'ffmpeg and ffprobe static binaries for goal detection',
});
```

**En las lambdas:** los binarios quedan disponibles en `/opt/bin/`. Configurar `fluent-ffmpeg` así:
```typescript
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');
ffmpeg.setFfprobePath('/opt/bin/ffprobe');
```

**Dependencia npm:** solo `fluent-ffmpeg`. No usar `@ffprobe-installer/ffprobe` — ese paquete incluye un binario propio que colisiona con el del Layer.

---

## Código compartido: `goal-event-writer`

### Patrón de Estrategia para señales

Todas las lambdas de señales (crowd-noise, transcribe, rekognition) persisten eventos en `goals-events` con la misma estructura. Para evitar errores manuales en la construcción del `eventId` y la lógica de TTL, se centraliza en un módulo compartido.

**Archivo:** `lambda/goals/shared/goal-event-writer.ts`

```typescript
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const TABLE  = process.env.GOALS_EVENTS_TABLE!;
const TTL_S  = 86400; // 24 horas

export type GoalSource = 'crowd_noise' | 'keyword' | 'visual';

export interface GoalEvent {
  source:      GoalSource;
  timestampMs: number;
  confidence:  number;
}

export interface TaskTokenEvent {
  service: 'transcribe' | 'rekognition';
  taskToken: string;
}

/**
 * Escribe un evento de señal en goals-events.
 * Construye el eventId con formato canónico: {source}#{timestampMs}#{chunkIndex}
 */
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

/**
 * Escribe un task token (de Transcribe o Rekognition) en goals-events.
 */
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
```

Todas las lambdas de señales importan `writeGoalEvent` y `writeTaskToken` en vez de construir los ítems manualmente. Esto garantiza formato consistente del `eventId` y TTL correcto.

---

## Estructura de archivos

```
video-processor/
├── layers/
│   └── ffmpeg/
│       └── bin/
│           ├── ffmpeg                    ← binario estático linux-x64
│           └── ffprobe                   ← binario estático linux-x64
├── lib/
│   ├── constructs/
│   │   └── goals-lambdas.ts          ← CREAR (incluye FfmpegLayer + todas las lambdas de goals)
│   └── step-functions/
│       └── definition.ts             ← MODIFICAR (único archivo donde cambia el flujo)
└── lambda/
    └── goals/
        ├── shared/
        │   └── goal-event-writer.ts  ← CREAR (módulo compartido de persistencia)
        ├── splitter/index.ts         ← CREAR (usa ffmpeg-layer)
        ├── crowd-noise/index.ts      ← CREAR (usa ffmpeg-layer)
        ├── transcribe/index.ts       ← CREAR (exports: launch, callback; launch usa ffmpeg-layer)
        ├── rekognition/index.ts      ← CREAR (exports: launch, callback)
        ├── fusion/index.ts           ← CREAR
        └── highlight/index.ts        ← CREAR (exports: launch, callback)
```

Además, en constructs existentes (solo se agregan líneas, no se modifica lógica):
- `lib/constructs/eventbridge-rules.ts` → agregar 3 reglas nuevas
- `lib/constructs/storage.ts` → agregar tabla `goals-events` + GSI + S3 lifecycle rule para `tmp/`
- `lib/stacks/video-processor-stack.ts` → instanciar `GoalsLambdas` construct

---

## Convención de nombres para jobs externos

Los nombres de jobs de Transcribe y los `ClientRequestToken` de Rekognition usan **doble underscore** (`__`) como separador:

```
goals__{jobId}__chunk{chunkIndex}     ← Transcribe
goals__{jobId}__full                  ← Rekognition (video completo)
```

**Por qué `__` y no `-`:** el `jobId` ya contiene guiones (formato `safeName-uuid`). Si usáramos `-chunk` como separador, el regex `(.+)-chunk(\d+)` fallaría si el `safeName` contuviera la cadena literal `-chunk`. Con `__` el regex `(.+)__chunk(\d+)` no tiene ambigüedad porque `__` no aparece en UUIDs ni en el safeName (que solo permite `[a-zA-Z0-9_-]` y `_` simple).

---

## Lambdas nuevas — detalle completo

Todas: **TypeScript, Node.js 20.x**, mismo runtime que el proyecto.

---

### goals/splitter

**Propósito:** obtener duración y características del video, validar que tiene audio, y generar los chunks. Es el guardián: si el video no tiene audio la branch termina aquí con `goalsStatus = NO_AUDIO` sin escribir nada más.

**Trigger:** Step Functions (invocación directa)
**Input:** `{ jobId: string, inputKey: string }`
**Output:** `{ hasAudio: boolean, chunks: Chunk[], fps: number, durationS: number }`
**Runtime:** Node.js 20.x | Timeout: 30s
**Lambda Layer:** `ffmpeg-layer` (provee `/opt/bin/ffprobe`)
**Permisos:** `s3:GetObject`, `dynamodb:UpdateItem` sobre tabla `jobs`
**Dependencias npm:** `fluent-ffmpeg`

```typescript
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');
ffmpeg.setFfprobePath('/opt/bin/ffprobe');

const CHUNK_S   = 600; // 10 minutos por chunk
const OVERLAP_S = 30;  // overlap para no perder goles en bordes de chunk

export const handler = async (event: { jobId: string; inputKey: string }) => {
  const url  = await getPresignedUrl(event.inputKey, 3600); // ffprobe lee headers, no descarga
  const info = await ffprobeAsync(url);

  const hasAudio = info.streams.some(s => s.codec_type === 'audio');
  const duration = parseFloat(info.format.duration);
  const fps      = parseFps(info.streams.find(s => s.codec_type === 'video')?.r_frame_rate);

  if (!hasAudio) {
    await updateJob(event.jobId, { goalsStatus: 'NO_AUDIO' });
    return { hasAudio: false, chunks: [] };
  }

  const totalChunks = Math.ceil(duration / CHUNK_S);
  const chunks = Array.from({ length: totalChunks }, (_, i) => ({
    chunkIndex: i,
    jobId:      event.jobId,
    inputKey:   event.inputKey,
    startS:     Math.max(0, i * CHUNK_S - OVERLAP_S), // incluye overlap
    endS:       Math.min((i + 1) * CHUNK_S, duration),
    offsetMs:   i * CHUNK_S * 1000, // inicio real del chunk, SIN el overlap
    fps,
  }));

  await updateJob(event.jobId, { goalsChunkCount: totalChunks });
  return { hasAudio: true, chunks, fps, durationS: duration };
};
```

**Por qué `offsetMs = i * CHUNK_S * 1000` y no `startS * 1000`:**
`startS` incluye el overlap (arranca 30s antes del chunk real). `offsetMs` apunta al inicio real del chunk. Cuando crowd-noise detecta un pico a los 15s dentro del audio extraído, el timestamp absoluto correcto es `15000 + offsetMs`. Si usáramos `startS * 1000` los timestamps quedarían corridos 30 segundos.

---

### goals/crowd-noise

**Propósito:** extraer el audio del segmento y detectar picos de excitación de la multitud usando RMS energy.

**Trigger:** Parallel interno del Map state
**Input:** `{ chunkIndex: number, jobId: string, inputKey: string, startS: number, endS: number, offsetMs: number }`
**Output:** escribe eventos en tabla `goals-events` via `writeGoalEvent`. Retorna `{ eventsWritten: number }`.
**Runtime:** Node.js 20.x | Timeout: 300s (5 min)
**Lambda Layer:** `ffmpeg-layer` (provee `/opt/bin/ffmpeg`)
**Permisos:** `s3:GetObject`, `dynamodb:PutItem` sobre tabla `goals-events`
**Dependencias npm:** `fluent-ffmpeg`

```typescript
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');
ffmpeg.setFfprobePath('/opt/bin/ffprobe');

import { writeGoalEvent } from '../shared/goal-event-writer';

const SAMPLE_RATE  = 22050;
const WINDOW_S     = 1.0;   // ventana de análisis: 1 segundo
const MIN_GAP_S    = 10;    // gap mínimo entre picos (no contar el mismo gol dos veces)
const PERCENTILE   = 90;    // umbral: percentil 90 de la energía del segmento

export const handler = async (event: ChunkEvent) => {
  try {
    // Extraer solo el audio del segmento con ffmpeg — no descarga el video completo
    // Comando: ffmpeg -ss startS -to endS -i presignedUrl -vn -ar 22050 -ac 1 -f f32le pipe:1
    const url         = await getPresignedUrl(event.inputKey, 3600);
    const audioBuffer = await extractAudioSegment(url, event.startS, event.endS, SAMPLE_RATE);

    // RMS energy por ventana de 1 segundo
    const samplesPerWindow = SAMPLE_RATE * WINDOW_S;
    const energyPerSecond: number[] = [];
    for (let i = 0; i < audioBuffer.length; i += samplesPerWindow) {
      const window = audioBuffer.slice(i, i + samplesPerWindow);
      const rms    = Math.sqrt(window.reduce((sum, s) => sum + s * s, 0) / window.length);
      energyPerSecond.push(rms);
    }

    // Umbral = percentil 90 del segmento
    const threshold = percentile(energyPerSecond, PERCENTILE);

    // Detectar picos locales por encima del umbral con gap mínimo
    const peaks = findLocalPeaks(energyPerSecond, threshold, MIN_GAP_S);

    // Guardar en goals-events con timestamp absoluto usando el módulo compartido
    for (const peak of peaks) {
      const absoluteMs = Math.round(peak.timeS * 1000) + event.offsetMs;
      await writeGoalEvent(event.jobId, event.chunkIndex, {
        source:      'crowd_noise',
        timestampMs: absoluteMs,
        confidence:  peak.normalizedEnergy, // energía relativa al máximo del segmento
      });
    }

    return { eventsWritten: peaks.length };
  } catch (err) {
    // Si ffmpeg falla (video corrupto, codec no soportado), no crashear el chunk entero.
    // Retornar 0 eventos — fusion seguirá funcionando con las otras señales.
    console.error(`crowd-noise failed for chunk ${event.chunkIndex} of job ${event.jobId}:`, err);
    return { eventsWritten: 0 };
  }
};
```

**Nota sobre RMS vs librosa:** RMS energy por ventana de 1 segundo es suficiente para detectar reacciones de estadio en Node.js sin dependencias externas complejas. La multitud durante un gol produce un incremento de energía sostenido y claramente distinguible. Lo que importa es la diferencia relativa dentro del mismo partido, y RMS lo captura bien.

---

### goals/transcribe

**Propósito:** extraer el audio del chunk a S3, transcribirlo con Amazon Transcribe, y detectar keywords de gol con filtro de contexto negativo.

**Exports:** `launch`, `callback`
**Runtime:** Node.js 20.x | Timeout: 120s (launch — incluye extracción de audio), 15s (callback)
**Lambda Layer:** `ffmpeg-layer` (provee `/opt/bin/ffmpeg` para extracción de audio en launch)
**Permisos launch:** `transcribe:StartTranscriptionJob`, `s3:GetObject`, `s3:PutObject`, `dynamodb:PutItem`
**Permisos callback:** `transcribe:GetTranscriptionJob`, `s3:GetObject`, `dynamodb:GetItem`, `states:SendTaskSuccess`, `states:SendTaskFailure`, `dynamodb:PutItem`
**Dependencias npm:** `fluent-ffmpeg`

```typescript
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');

import { writeGoalEvent, writeTaskToken } from '../shared/goal-event-writer';

const CHUNK_S  = 600;
const KEYWORDS = (process.env.GOAL_KEYWORDS ?? 'gol,golazo,goool,goal').split(',');
const NEGATIVES = ['no fue', 'no es', 'no hubo', 'anulado', 'fuera de juego'];

// launch — invocado por Step Functions con WAIT_FOR_TASK_TOKEN
export const launch = async (event: ChunkEvent & { taskToken: string }) => {
  // Guardar task token en goals-events (no en jobs)
  await writeTaskToken(event.jobId, event.chunkIndex, {
    service:   'transcribe',
    taskToken: event.taskToken,
  });

  // Extraer solo el audio del chunk y subirlo a S3 como .mp4 (audio-only).
  // Esto evita que Transcribe procese el video completo N veces.
  const inputUrl = await getPresignedUrl(event.inputKey, 3600);
  const audioKey = `tmp/${event.jobId}/audio-chunk-${event.chunkIndex}.mp4`;
  await extractAndUploadAudioChunk(inputUrl, event.startS, event.endS, audioKey);

  await transcribe.startTranscriptionJob({
    TranscriptionJobName: `goals__${event.jobId}__chunk${event.chunkIndex}`,
    Media: { MediaFileUri: `s3://${BUCKET}/${audioKey}` },
    MediaFormat: 'mp4',
    LanguageCode: process.env.TRANSCRIBE_LANGUAGE ?? 'es-ES',
    Settings: { ShowSpeakerLabels: false },
  });
};

// extractAndUploadAudioChunk — extrae audio con ffmpeg y sube a S3 en streaming
async function extractAndUploadAudioChunk(
  inputUrl: string, startS: number, endS: number, outputKey: string
): Promise<void> {
  const { PassThrough } = await import('stream');
  const passthrough = new PassThrough();

  const upload = s3.upload({
    Bucket: BUCKET,
    Key:    outputKey,
    Body:   passthrough,
    ContentType: 'audio/mp4',
  }).promise();

  ffmpeg(inputUrl)
    .seekInput(startS)
    .duration(endS - startS)
    .noVideo()
    .audioCodec('aac')
    .audioBitrate('64k')
    .format('mp4')
    .outputOptions('-movflags', 'frag_keyframe+empty_moov') // streamable mp4
    .pipe(passthrough, { end: true });

  await upload;
}

// callback — invocado por EventBridge cuando Transcribe termina
export const callback = async (event: AWSEventBridgeEvent) => {
  const jobName = event.detail.TranscriptionJobName as string;
  if (!jobName?.startsWith('goals__')) return; // no es nuestro job

  // Extraer jobId y chunkIndex del nombre del job
  // Formato: goals__{jobId}__chunk{chunkIndex}
  const match = jobName.match(/^goals__(.+)__chunk(\d+)$/);
  if (!match) return;
  const [, jobId, chunkStr] = match;
  const chunkIndex = parseInt(chunkStr);
  const offsetMs   = chunkIndex * CHUNK_S * 1000;

  // Recuperar task token de goals-events
  const tokenItem = await getGoalEvent(jobId, `task_token#transcribe#${chunkIndex}`);
  if (!tokenItem?.taskToken) return;

  if (event.detail.TranscriptionJobStatus === 'FAILED') {
    await sfn.sendTaskFailure({ taskToken: tokenItem.taskToken, error: 'TranscribeFailed', cause: '' });
    return;
  }

  // Parsear transcript y buscar keywords con filtro de contexto negativo.
  // Los timestamps de Transcribe son relativos al audio del chunk extraído.
  // offsetMs apunta al inicio real del chunk (sin overlap), así que los timestamps absolutos son correctos.
  const transcript = await fetchTranscriptJson(event.detail.Transcript?.TranscriptFileUri);
  const items      = transcript.results?.items ?? [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'pronunciation') continue;
    const word = item.alternatives[0]?.content?.toLowerCase() ?? '';
    if (!KEYWORDS.includes(word)) continue;

    // Contexto: las 3 palabras anteriores
    const context = items.slice(Math.max(0, i - 3), i)
      .filter(it => it.type === 'pronunciation')
      .map(it => it.alternatives[0]?.content?.toLowerCase() ?? '')
      .join(' ');
    if (NEGATIVES.some(neg => context.includes(neg))) continue;

    const absoluteMs = Math.round(parseFloat(item.start_time) * 1000) + offsetMs;
    await writeGoalEvent(jobId, chunkIndex, {
      source:      'keyword',
      timestampMs: absoluteMs,
      confidence:  parseFloat(item.alternatives[0]?.confidence ?? '0'),
    });
  }

  await sfn.sendTaskSuccess({ taskToken: tokenItem.taskToken, output: JSON.stringify({ done: true }) });
};
```

**Importante:** el `offsetMs` se recalcula a partir del `chunkIndex` (`chunkIndex * CHUNK_S * 1000`) porque el evento de EventBridge de Transcribe no incluye ese dato. Por eso el `chunkIndex` debe estar embebido en el nombre del job.

**Extracción de audio por chunk:** el launch extrae el audio del segmento `[startS, endS]` y lo sube a `tmp/{jobId}/audio-chunk-{N}.mp4` antes de invocar Transcribe. Esto evita que Transcribe procese el video completo N veces. Los archivos temporales en `tmp/` se limpian con una lifecycle rule de S3 de 48h (ver sección de storage).

---

### goals/rekognition

**Propósito:** detectar labels visuales de celebración. Se ejecuta **una sola vez** por job sobre el video completo (fuera del Map state).

**Exports:** `launch`, `callback`
**Runtime:** Node.js 20.x | Timeout: 30s (launch), 60s (callback)
**Permisos launch:** `rekognition:StartLabelDetection`, `iam:PassRole`, `dynamodb:PutItem`
**Permisos callback:** `rekognition:GetLabelDetection`, `dynamodb:GetItem`, `states:SendTaskSuccess`, `states:SendTaskFailure`, `dynamodb:PutItem`

```typescript
import { writeGoalEvent, writeTaskToken } from '../shared/goal-event-writer';

const GOAL_LABELS = ['Celebration', 'Cheering', 'Sport', 'Soccer', 'Football', 'Crowd'];

export const launch = async (event: { jobId: string; inputKey: string; taskToken: string }) => {
  // Guardar task token — chunkIndex = 0 porque es ejecución única
  await writeTaskToken(event.jobId, 0, {
    service:   'rekognition',
    taskToken: event.taskToken,
  });

  await rekognition.startLabelDetection({
    Video:          { S3Object: { Bucket: BUCKET, Name: event.inputKey } },
    MinConfidence:  70,
    ClientRequestToken: `goals__${event.jobId}__full`,
    NotificationChannel: {
      SNSTopicArn: process.env.REKOGNITION_SNS_TOPIC!,
      RoleArn:     process.env.REKOGNITION_ROLE_ARN!,
    },
  });
};

export const callback = async (event: AWSEventBridgeEvent) => {
  const token = event.detail.ClientRequestToken as string;
  if (!token?.startsWith('goals__')) return;

  // Formato: goals__{jobId}__full
  const match = token.match(/^goals__(.+)__full$/);
  if (!match) return;
  const [, jobId] = match;

  const tokenItem = await getGoalEvent(jobId, `task_token#rekognition#0`);
  if (!tokenItem?.taskToken) return;

  if (event.detail.Status === 'FAILED') {
    await sfn.sendTaskFailure({ taskToken: tokenItem.taskToken, error: 'RekognitionFailed', cause: '' });
    return;
  }

  // Obtener todas las detecciones del video completo
  const labels = await getAllLabelDetections(event.detail.JobId, GOAL_LABELS);

  // Agrupar detecciones contiguas (gap < 3s = mismo momento)
  const groups = groupContiguous(labels, 3000);
  for (const group of groups) {
    const absoluteMs = group[0].Timestamp; // ya en ms absolutos desde el inicio del video
    // chunkIndex = 0 para todas las detecciones de Rekognition (ejecución única)
    await writeGoalEvent(jobId, 0, {
      source:      'visual',
      timestampMs: absoluteMs,
      confidence:  (group[0].Label?.Confidence ?? 0) / 100,
    });
  }

  await sfn.sendTaskSuccess({ taskToken: tokenItem.taskToken, output: JSON.stringify({ done: true }) });
};
```

**Nota:** ya no hay filtrado por rango de chunk porque Rekognition se ejecuta una sola vez. Todos los labels del video completo se persisten y Fusion los usa directamente.

---

### goals/fusion

**Propósito:** leer todos los eventos de `goals-events` y aplicar el algoritmo Anchor+Confirm con Score de Valencia.

**Trigger:** Step Functions, después del Parallel (GoalsProcessing)
**Input:** `{ jobId: string }`
**Output:** `{ goals: GoalClip[] }`
**Runtime:** Node.js 20.x | Timeout: 60s
**Permisos:** `dynamodb:Query` sobre GSI `jobId-source-index` de `goals-events`, `dynamodb:UpdateItem` sobre `jobs`, `cloudwatch:PutMetricData`

**Nota sobre paginación:** `queryEventsBySource` debe manejar `LastEvaluatedKey` para paginar resultados. Un partido de 2 horas puede generar cientos de eventos por señal, y DynamoDB pagina a 1MB por query.

```typescript
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cw = new CloudWatchClient({});

const WINDOW_MS         = parseInt(process.env.WINDOW_MS          ?? '8000');
const REACTION_DELAY_MS = parseInt(process.env.REACTION_DELAY_MS  ?? '2000');
const CLIP_BEFORE_MS    = parseInt(process.env.CLIP_BEFORE_MS     ?? '5000');
const CLIP_AFTER_MS     = parseInt(process.env.CLIP_AFTER_MS      ?? '8000');
const MIN_GAP_MS        = parseInt(process.env.MIN_GAP_MS         ?? '15000');
const MIN_SCORE         = parseFloat(process.env.MIN_SCORE        ?? '0.5');

// Pesos de valencia: no todas las confirmaciones valen lo mismo.
// Un keyword "GOL" es evidencia mucho más fuerte que un label visual de "Crowd"
// (que podría ser un córner, un tiro libre, etc).
const VALENCIA_WEIGHTS: Record<string, number> = {
  keyword: 1.0,   // "gol", "golazo" — señal más específica
  visual:  0.4,   // Celebration, Cheering — puede ser falso positivo
};

export const handler = async (event: { jobId: string }) => {
  // Query paralelo por señal usando el GSI (con paginación)
  const [crowdEvents, keywordEvents, visualEvents] = await Promise.all([
    queryAllEventsBySource(event.jobId, 'crowd_noise'),
    queryAllEventsBySource(event.jobId, 'keyword'),
    queryAllEventsBySource(event.jobId, 'visual'),
  ]);

  // Ordenar todos los eventos confirmadores por timestamp para sliding window
  const confirmers = [...keywordEvents, ...visualEvents].sort(
    (a, b) => a.timestampMs - b.timestampMs
  );

  // Anchor+Confirm con sliding window:
  // crowd_noise es el anchor (señal más objetiva y temporal).
  // Para cada anchor, buscar confirmadores dentro de WINDOW_MS usando puntero deslizante.
  const confirmed: GoalClip[] = [];
  let windowStart = 0;

  for (const anchor of crowdEvents.sort((a, b) => a.timestampMs - b.timestampMs)) {
    const lower = anchor.timestampMs - WINDOW_MS;
    const upper = anchor.timestampMs + WINDOW_MS;

    // Avanzar windowStart hasta el primer confirmador dentro del rango
    while (windowStart < confirmers.length && confirmers[windowStart].timestampMs < lower) {
      windowStart++;
    }

    // Recolectar confirmadores dentro de la ventana y calcular score
    let score = 0;
    const confirming: string[] = [];
    for (let j = windowStart; j < confirmers.length && confirmers[j].timestampMs <= upper; j++) {
      const e = confirmers[j];
      const weight = VALENCIA_WEIGHTS[e.source] ?? 0.3;
      score += weight * e.confidence;
      confirming.push(e.source);
    }

    if (score < MIN_SCORE) continue; // score insuficiente = descartado

    const goalMs = anchor.timestampMs - REACTION_DELAY_MS;
    confirmed.push({
      goalMs,
      clipStartMs: Math.max(0, goalMs - CLIP_BEFORE_MS),
      clipEndMs:   anchor.timestampMs + CLIP_AFTER_MS,
      confirmedBy: confirming,
      score,
    });
  }

  // Deduplicar: dos anchors a menos de MIN_GAP_MS = mismo gol detectado dos veces.
  // Esto ocurre cuando un gol cae en el overlap entre dos chunks.
  // Se queda el de mayor score.
  const deduped = confirmed.reduce<GoalClip[]>((acc, goal) => {
    const last = acc[acc.length - 1];
    if (last && (goal.goalMs - last.goalMs) < MIN_GAP_MS) {
      // Quedarse con el de mayor score
      if (goal.score > last.score) acc[acc.length - 1] = goal;
      return acc;
    }
    return [...acc, goal];
  }, []);

  // Emitir métricas de observabilidad a CloudWatch
  await emitFusionMetrics(event.jobId, {
    anchorsDetected: crowdEvents.length,
    keywordsDetected: keywordEvents.length,
    visualsDetected: visualEvents.length,
    confirmedGoals: deduped.length,
    discardedAnchors: crowdEvents.length - confirmed.length,
  });

  await updateJob(event.jobId, { goalsCount: deduped.length });
  return { goals: deduped };
};

// --- Observabilidad ---

interface FusionMetrics {
  anchorsDetected:  number;
  keywordsDetected: number;
  visualsDetected:  number;
  confirmedGoals:   number;
  discardedAnchors: number;
}

async function emitFusionMetrics(jobId: string, m: FusionMetrics): Promise<void> {
  const namespace = 'VideoProcessor/Goals';
  const timestamp = new Date();
  const dimensions = [{ Name: 'JobId', Value: jobId }];

  await cw.send(new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: [
      { MetricName: 'AnchorsDetected',    Value: m.anchorsDetected,  Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'KeywordsDetected',   Value: m.keywordsDetected, Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'VisualsDetected',    Value: m.visualsDetected,  Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'ConfirmedGoals',     Value: m.confirmedGoals,   Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      { MetricName: 'DiscardedAnchors',   Value: m.discardedAnchors, Unit: 'Count', Timestamp: timestamp, Dimensions: dimensions },
      {
        MetricName: 'FalsePositiveRatio',
        Value: m.anchorsDetected > 0
          ? m.discardedAnchors / m.anchorsDetected
          : 0,
        Unit: 'None',
        Timestamp: timestamp,
        Dimensions: dimensions,
      },
    ],
  }));
}

// --- Paginación de DynamoDB ---

async function queryAllEventsBySource(jobId: string, source: string): Promise<GoalEventItem[]> {
  const results: GoalEventItem[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const response = await dynamo.send(new QueryCommand({
      TableName: GOALS_EVENTS_TABLE,
      IndexName: 'jobId-source-index',
      KeyConditionExpression: 'jobId = :jid AND source = :src',
      ExpressionAttributeValues: marshall({ ':jid': jobId, ':src': source }),
      ExclusiveStartKey: lastKey,
    }));

    if (response.Items) {
      results.push(...response.Items.map(item => unmarshall(item) as GoalEventItem));
    }
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  return results;
}
```

### Métricas de CloudWatch emitidas

| Métrica | Descripción | Uso |
|---|---|---|
| `AnchorsDetected` | Picos de crowd noise encontrados | Si es 0, el PERCENTILE está demasiado alto o el audio es malo |
| `KeywordsDetected` | Keywords de gol detectadas por Transcribe | Si es 0, revisar idioma o lista de keywords |
| `VisualsDetected` | Labels de celebración detectados por Rekognition | Correlacionar con false positives |
| `ConfirmedGoals` | Goles que pasaron Anchor+Confirm con score ≥ MIN_SCORE | Número final de highlights |
| `DiscardedAnchors` | Anchors sin confirmación suficiente | Anchors - Confirmed |
| `FalsePositiveRatio` | `DiscardedAnchors / AnchorsDetected` | Si es > 0.9, el umbral de crowd-noise es demasiado sensible |

Estas métricas permiten ajustar `PERCENTILE`, `WINDOW_MS`, `MIN_SCORE` y `VALENCIA_WEIGHTS` basándose en datos reales de producción.

---

### goals/highlight

**Propósito:** lanzar MediaConvert para concatenar los clips de goles en un único `.mp4`.

**Exports:** `launch`, `callback`
**Runtime:** Node.js 20.x | Timeout: 30s (launch), 15s (callback)
**Permisos launch:** `mediaconvert:CreateJob`, `iam:PassRole`, `s3:GetObject`, `s3:PutObject`, `dynamodb:UpdateItem`
**Permisos callback:** `states:SendTaskSuccess`, `states:SendTaskFailure`, `dynamodb:GetItem`, `dynamodb:UpdateItem`

```typescript
export const launch = async (event: { jobId: string; goals: GoalClip[]; taskToken: string; inputKey: string; fps: number }) => {
  // Caso sin goles: terminar limpiamente sin lanzar MediaConvert
  if (event.goals.length === 0) {
    await updateJob(event.jobId, { goalsStatus: 'DONE', goalsCount: 0 });
    await sfn.sendTaskSuccess({ taskToken: event.taskToken, output: JSON.stringify({ noGoals: true }) });
    return;
  }

  await updateJob(event.jobId, { goalsTaskToken: event.taskToken });

  const inputClippings = event.goals.map(goal => ({
    StartTimecode: msToTimecode(goal.clipStartMs, event.fps),
    EndTimecode:   msToTimecode(goal.clipEndMs,   event.fps),
  }));

  await mediaconvert.createJob({
    Role:         process.env.MEDIACONVERT_ROLE_ARN!,
    UserMetadata: { branch: 'goals', jobId: event.jobId },
    Settings: {
      Inputs: [{ FileInput: `s3://${BUCKET}/${event.inputKey}`, InputClippings: inputClippings }],
      OutputGroups: [{
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: `s3://${BUCKET}/output/${event.jobId}/goals/` },
        },
        Outputs: [{ /* MP4 1080p output settings, igual que qualities */ }],
      }],
    },
  });
};

// callback — mismo patrón que QualitiesCallback existente
export const callback = async (event: AWSEventBridgeEvent) => {
  if (event.detail.userMetadata?.branch !== 'goals') return;
  const { jobId } = event.detail.userMetadata;

  const item = await getJobItem(jobId);
  if (!item?.goalsTaskToken) return;

  if (event.detail.status === 'COMPLETE') {
    await updateJob(jobId, {
      goalsStatus:    'DONE',
      goalsOutputKey: `output/${jobId}/goals/highlight.mp4`,
    });
    await sfn.sendTaskSuccess({ taskToken: item.goalsTaskToken, output: JSON.stringify({ done: true }) });
  } else {
    await updateJob(jobId, { goalsStatus: 'FAILED' });
    await sfn.sendTaskFailure({ taskToken: item.goalsTaskToken, error: 'MediaConvertFailed', cause: event.detail.status });
  }
};
```

---

## Cambios en definition.ts

```typescript
// lib/step-functions/definition.ts

// Choice state: si el video no tiene audio, saltar toda la detección
const checkHasAudio = new sfn.Choice(scope, 'HasAudio?')
  .when(sfn.Condition.booleanEquals('$.hasAudio', false), updateGoalsNoAudio)
  .otherwise(goalsProcessing);

// --- Branch del Map: crowd-noise + Transcribe por chunk ---

const goalsMap = new sfn.Map(scope, 'GoalsMap', {
  maxConcurrency: 12,
  itemsPath:      sfn.JsonPath.stringAt('$.chunks'),
  parameters:     { 'chunk.$': '$$.Map.Item.Value' },
});

// Parallel interno por chunk: solo 2 señales (crowd-noise + Transcribe)
const chunkSignals = new sfn.Parallel(scope, 'ChunkSignals')
  .branch(crowdNoiseAnalysis)
  .branch(transcribeJob);    // WAIT_FOR_TASK_TOKEN

goalsMap.iterator(chunkSignals);

// --- Rekognition: fuera del Map, video completo, una sola vez ---

const rekognitionFullVideo = new tasks.LambdaInvoke(scope, 'RekognitionFullVideo', {
  lambdaFunction: goalsRekognitionLaunch,
  integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
  payload: sfn.TaskInput.fromObject({
    'jobId.$':    '$.jobId',
    'inputKey.$': '$.inputKey',
    'taskToken':  sfn.JsonPath.taskToken,
  }),
});

// --- Parallel principal de goals: Map + Rekognition en paralelo ---

const goalsProcessing = new sfn.Parallel(scope, 'GoalsProcessing')
  .branch(goalsMap)
  .branch(rekognitionFullVideo);

// Conectar con fusion y highlight
goalsProcessing
  .next(goalsFusion)
  .next(
    launchGoalsHighlight   // WAIT_FOR_TASK_TOKEN
      .addCatch(updateGoalsFailed, { errors: ['States.ALL'] })
      .next(updateGoalsDone)
  );

// Branch B completa
const goalsBranch = videoSplitter.next(checkHasAudio);

// Parallel principal: qualities (existente) + goals (nueva)
const parallel = new sfn.Parallel(scope, 'ProcessingBranches')
  .branch(
    launchMediaConvertQualities             // Branch A: sin cambios
      .addCatch(updateQualitiesFailed, { errors: ['States.ALL'] })
      .next(updateQualitiesDone)
  )
  .branch(goalsBranch);                     // Branch B: nueva

// Chain principal con timeout corregido (BUG-04)
const definition = registerStart.next(parallel);
```

---

## EventBridge rules nuevas

Agregar al construct `lib/constructs/eventbridge-rules.ts`:

| Regla | Fuente | Condición | Target |
|---|---|---|---|
| `GoalsTranscribeRule` | `aws.transcribe` | `TranscriptionJobName` starts with `goals__` | `GoalsTranscribeCallback` |
| `GoalsRekognitionRule` | `aws.rekognition` | `ClientRequestToken` starts with `goals__` | `GoalsRekognitionCallback` |
| `GoalsMediaConvertRule` | `aws.mediaconvert` | `userMetadata.branch = "goals"` | `GoalsHighlightCallback` |

---

## Storage: cambios en `lib/constructs/storage.ts`

### Tabla `goals-events`

Agregar la tabla y GSI según el diseño descrito en la sección de DynamoDB.

### S3 lifecycle rule para `tmp/`

Los archivos de audio extraídos para Transcribe se guardan en `tmp/{jobId}/audio-chunk-{N}.mp4`. Agregar una lifecycle rule para limpieza automática:

```typescript
bucket.addLifecycleRule({
  id: 'CleanupTmpAudioChunks',
  prefix: 'tmp/',
  expiration: Duration.days(2), // 48 horas
});
```

---

## Plan de acción — 5 fases

### Fase 0 — Corregir bugs del proyecto existente

1. **BUG-01:** eliminar `s3:PutObject` del Orchestrator en `lambdas.ts`.
2. **BUG-02:** sanitizar filename en `orchestrator/index.ts`.
3. **BUG-03:** agregar idempotencia con `ConditionExpression` en `orchestrator/index.ts`.
4. **BUG-04:** subir timeout a 4h en `state-machine.ts`.
5. `cdk deploy` y verificar que el flujo de qualities sigue funcionando.

**Entregable:** proyecto existente con los 4 bugs corregidos.

---

### Fase 1 — Storage + Layer + Splitter + Shared

1. Descargar binarios estáticos de ffmpeg/ffprobe y colocar en `layers/ffmpeg/bin/`.
2. Agregar tabla `goals-events` con GSI en `storage.ts`.
3. Agregar S3 lifecycle rule para `tmp/` con expiración de 48h en `storage.ts`.
4. Crear `lambda/goals/shared/goal-event-writer.ts` con `writeGoalEvent` y `writeTaskToken`.
5. Crear `lib/constructs/goals-lambdas.ts` con `FfmpegLayer` y `GoalsSplitter`.
6. Crear `lambda/goals/splitter/index.ts` con validación de audio y generación de chunks.
7. Instanciar en `video-processor-stack.ts`.
8. Test manual con un video que tiene audio y otro que no.

**Entregable:** Layer deployado, módulo compartido listo, Splitter funcionando, retorna chunks con `offsetMs` correcto, maneja `NO_AUDIO`.

---

### Fase 2 — Las tres señales

1. Crear `lambda/goals/crowd-noise/index.ts` (asignar `ffmpeg-layer`, usa `writeGoalEvent`).
2. Crear `lambda/goals/transcribe/index.ts` (launch + callback; launch usa `ffmpeg-layer` para extraer audio del chunk a S3, ambos usan `writeGoalEvent`/`writeTaskToken`).
3. Crear `lambda/goals/rekognition/index.ts` (launch + callback; ejecución única sobre video completo, usa `writeGoalEvent`/`writeTaskToken`).
4. Agregar lambdas a `goals-lambdas.ts` con los layers correspondientes.
5. Agregar 3 EventBridge rules a `eventbridge-rules.ts` (prefix `goals__`).
6. Test de cada lambda con payloads reales.

**Entregable:** las 3 señales escriben en `goals-events` con `timestampMs` absoluto correcto. Verificar en DynamoDB que los timestamps son coherentes con el video.

---

### Fase 3 — Fusion + Highlight + Observabilidad

1. Crear `lambda/goals/fusion/index.ts` con Anchor+Confirm, Score de Valencia, sliding window, paginación DynamoDB y métricas CloudWatch.
2. Crear `lambda/goals/highlight/index.ts` (launch + callback).
3. Agregar al construct y al stack. Agregar permiso `cloudwatch:PutMetricData` a fusion.
4. Test de fusion con eventos reales de las fases anteriores.
5. Verificar el caso `goals.length === 0` — highlight no debe lanzar MediaConvert.
6. Verificar que las métricas aparecen en CloudWatch bajo `VideoProcessor/Goals`.

**Entregable:** fusion retorna lista de goles validados con scores; highlight produce `output/{jobId}/goals/highlight.mp4`; métricas visibles en CloudWatch.

---

### Fase 4 — Step Function Parallel + integración completa

1. Modificar `definition.ts`: agregar `Parallel` principal, branch goals con Map state (crowd-noise + Transcribe), Rekognition como rama paralela al Map, y `Choice` para `HasAudio`.
2. `cdk diff`: verificar que el único cambio en Step Functions es el `Parallel` con la nueva estructura.
3. Test end-to-end con un video corto (~5 min) para verificar el flujo completo.
4. Test con un video largo (+2 horas) para verificar chunking, `offsetMs` y deduplicación.
5. Ajustar `WINDOW_MS`, `MIN_SCORE`, `VALENCIA_WEIGHTS`, `CLIP_BEFORE_MS`, `REACTION_DELAY_MS` usando las métricas de CloudWatch con datos reales.

**Entregable:** pipeline completo en producción, ambas branches corriendo en paralelo, Rekognition ejecutándose una sola vez por job.

---

## Resumen de todos los cambios

| Archivo | Acción | Descripción |
|---|---|---|
| `lambda/orchestrator/index.ts` | **CORREGIR** | BUG-02 (jobId sanitizado) + BUG-03 (idempotencia) |
| `lib/constructs/lambdas.ts` | **CORREGIR** | BUG-01 (permiso s3:PutObject sobrante) |
| `lib/constructs/state-machine.ts` | **CORREGIR** | BUG-04 (timeout 4h) |
| `layers/ffmpeg/bin/` | CREAR | Binarios estáticos ffmpeg + ffprobe para Lambda Layer |
| `lambda/goals/shared/goal-event-writer.ts` | CREAR | Módulo compartido: `writeGoalEvent`, `writeTaskToken` (TTL + eventId canónico) |
| `lib/constructs/storage.ts` | AGREGAR | Tabla `goals-events` + GSI + S3 lifecycle rule `tmp/` 48h |
| `lib/constructs/goals-lambdas.ts` | CREAR | Construct con FfmpegLayer + todas las lambdas de goals |
| `lib/constructs/eventbridge-rules.ts` | AGREGAR | 3 reglas nuevas (prefix `goals__`) |
| `lib/stacks/video-processor-stack.ts` | AGREGAR | Instanciar GoalsLambdas |
| `lib/step-functions/definition.ts` | **MODIFICAR** | Parallel + branch goals (Rekognition fuera del Map) |
| `lambda/goals/splitter/index.ts` | CREAR | ffprobe (via Layer) + chunks + validación audio |
| `lambda/goals/crowd-noise/index.ts` | CREAR | ffmpeg (via Layer) + RMS energy + detección de picos + try/catch |
| `lambda/goals/transcribe/index.ts` | CREAR | launch (extrae audio chunk a S3 via Layer) + callback Transcribe |
| `lambda/goals/rekognition/index.ts` | CREAR | launch (video completo, `iam:PassRole`) + callback Rekognition |
| `lambda/goals/fusion/index.ts` | CREAR | Anchor+Confirm + Score de Valencia + sliding window + paginación + métricas CloudWatch |
| `lambda/goals/highlight/index.ts` | CREAR | launch + callback MediaConvert goals |
