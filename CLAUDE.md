# Video Processor Project

## Resumen

Pipeline serverless en AWS CDK (Node.js + TypeScript) que recibe un video crudo en S3, lo procesa en dos branches paralelos mediante Step Functions, y produce dos outputs independientes: calidades de video en HLS y un highlight reel. El análisis de momentos clave se realiza con **Amazon Bedrock — modelo `twelvelabs.pegasus-1-2-v1:0`** invocado sincrónicamente desde un **contenedor Fargate**. No se guardan clips intermedios — el highlight reel se genera en un único job de MediaConvert con múltiples `InputClippings`.

---

## Infraestructura general

### S3 — bucket único

Un solo bucket: `video-processor-{stage}-media`

```
s3://video-processor-{stage}-media/
├── input/          ← videos crudos subidos por el usuario (.mp4)
└── output/{jobId}/
    ├── qualities/  ← HLS multi-resolución (5 calidades)
    └── highlights/ ← highlight reel 720p
```

El trigger de S3 filtra por `prefix: input/` y `suffix: .mp4`.

### Flujo de entrada

1. El usuario sube un `.mp4` a `input/` del bucket
2. `s3:ObjectCreated` dispara la **Lambda orquestadora**
3. La Lambda genera un `jobId` = `{filename}-{UUIDv4}`, crea el item en DynamoDB, e inicia la Step Function

---

## Step Function — estructura general

```
RegisterStart (DynamoPutItem)
└── ParallelProcess (Parallel state)
    ├── Branch A — calidades de video
    └── Branch B — análisis Pegasus + highlight reel
```

Los branches son independientes; si uno falla, el otro continúa. El Parallel state cierra cuando ambos terminan. Timeout total: **2 horas**.

---

## Branch A — Calidades de video

### Pasos

1. **LaunchMediaConvertQualities** (`LambdaInvoke` con `WAIT_FOR_TASK_TOKEN`)
   - Llama a `lambda/qualities/index.ts → launch`
   - El `taskToken` se guarda en DynamoDB (`qualitiesTaskToken`) porque `UserMetadata` de MediaConvert tiene límite de 256 caracteres
   - MediaConvert transcode a 5 resoluciones HLS: 1080p, 720p, 480p, 360p, 240p
   - Output: `output/{jobId}/qualities/`
   - `UserMetadata`: `{ branch: "qualities", jobId }`
2. MediaConvert termina → EventBridge → **Lambda QualitiesCallback** (`lambda/qualities/index.ts → callback`)
   - Lee `qualitiesTaskToken` desde DynamoDB → llama a `SendTaskSuccess` o `SendTaskFailure`
3. **UpdateQualitiesDone** (DynamoUpdateItem: `qualitiesStatus = DONE`)

En caso de error en MediaConvert: **UpdateQualitiesFailed** (`qualitiesStatus = FAILED`) + el branch termina exitosamente desde la perspectiva del Parallel.

### Estados de `qualitiesStatus`
```
PENDING → DONE | FAILED
```

---

## Branch B — Análisis Pegasus + Highlight reel

### Pasos

#### B1 — InvokePegasus (`EcsRunTask` con `WAIT_FOR_TASK_TOKEN`)
- Step Functions lanza una tarea **Fargate** en `fargate/pegasus/`
- Variables de entorno inyectadas: `TASK_TOKEN`, `JOB_ID`, `INPUT_KEY`, `BEDROCK_MODEL_ID`
- El container llama sincrónicamente a Bedrock `InvokeModel` con el modelo `BEDROCK_MODEL_ID`
- Prompt: detectar todos los goles del partido y devolver array de timestamps
- Al terminar, el container llama a `SendTaskSuccess` con `{ timestamps: [...] }` (o `SendTaskFailure` si falla)
- Resultado disponible en `$.pegasus.timestamps`

Formato de timestamps esperado de Bedrock/Pegasus:
```json
[
  { "start": "00:32", "end": "00:45", "label": "gol" },
  { "start": "01:10", "end": "01:28", "label": "gol" }
]
```
Convertido internamente a formato MediaConvert `InputClipping`: `{ StartTimecode: "00:MM:SS:00", EndTimecode: "00:MM:SS:00" }`.

#### B2 — CheckTimestamps (Choice)
- Condición: `sfn.Condition.isPresent('$.pegasus.timestamps[0]')`
  - Array con al menos un elemento → continuar a B3
  - Array vacío → **UpdateHighlightsFailed** + `Succeed` (branch termina sin propagar error)

#### B3 — UpdateHighlightsStatus + LaunchMediaConvertHighlight
- **UpdateHighlightsStatus**: `highlightsStatus = HIGHLIGHTS`
- **LaunchMediaConvertHighlight** (`LambdaInvoke` con `WAIT_FOR_TASK_TOKEN`)
  - Llama a `lambda/highlights/index.ts → launch`
  - El `taskToken` se guarda en DynamoDB (`highlightsTaskToken`)
  - MediaConvert genera highlight reel HLS en **720p** con todos los `InputClippings` en secuencia
  - Output: `output/{jobId}/highlights/`
  - `UserMetadata`: `{ branch: "highlights", jobId }`
- MediaConvert termina → EventBridge → **Lambda HighlightsCallback** (`lambda/highlights/index.ts → callback`)
  - Lee `highlightsTaskToken` desde DynamoDB → llama a `SendTaskSuccess` o `SendTaskFailure`
- **UpdateHighlightsDone**: `highlightsStatus = DONE`

En caso de error en MediaConvert highlights: **UpdateHighlightsFailedOnMediaConvert** (`highlightsStatus = FAILED`).

### Estados de `highlightsStatus`
```
PEGASUS → HIGHLIGHTS → DONE | FAILED
```
`FAILED` puede ocurrir en cualquier transición.

---

## DynamoDB — Tabla `video-processor-{stage}-jobs`

| Campo | Tipo | Descripción |
|---|---|---|
| `jobId` | String (PK) | `{filename}-{UUIDv4}` |
| `qualitiesStatus` | String | `PENDING` → `DONE` \| `FAILED` |
| `highlightsStatus` | String | `PEGASUS` → `HIGHLIGHTS` → `DONE` \| `FAILED` |
| `outputVideo` | String | `s3://{bucket}/output/{jobId}/` |
| `inputKey` | String | `s3://{bucket}/input/{filename}.mp4` |
| `createdAt` | String | ISO timestamp (referencia) |
| `ttl` | Number | Unix timestamp = `now + 7 días` — atributo TTL de DynamoDB |
| `qualitiesTaskToken` | String | Task token de Step Functions para callback de qualities |
| `highlightsTaskToken` | String | Task token de Step Functions para callback de highlights |

### Notas
- Los task tokens se guardan en DynamoDB porque `UserMetadata` de MediaConvert tiene límite de 256 caracteres
- Los timestamps de Pegasus **no se persisten** — viven solo en la ejecución de Step Functions
- Billing mode: `PAY_PER_REQUEST`

---

## Fargate Pegasus

- **VPC**: propia, 2 AZs, subnets públicas, sin NAT gateways
- **Security Group**: permite todo el tráfico saliente (`allowAllOutbound: true`)
- **Tarea Fargate**: 256 CPU / 512 MB RAM, `assignPublicIp: true`
- **Image**: construida desde `fargate/pegasus/` (Dockerfile local)
- **Permisos del task role**: `bedrock:InvokeModel`, `states:SendTaskSuccess`, `states:SendTaskFailure`, `s3:GetObject` en el bucket
- `BEDROCK_MODEL_ID` debe configurarse como variable de entorno en el host antes del deploy (`process.env.BEDROCK_MODEL_ID` leído en `bin/video-processor.ts`)

---

## Lambdas

### Orchestrator — `lambda/orchestrator/index.ts`
- **Trigger**: S3 `ObjectCreated` en `input/*.mp4`
- Genera `jobId = {filename}-{UUIDv4}`, escribe item en DynamoDB, inicia Step Function
- Runtime: Node.js 20.x, timeout: 15 s
- **Permisos**: `dynamodb:PutItem`, `states:StartExecution`, `s3:PutObject`

### QualitiesLaunch — `lambda/qualities/index.ts → launch`
- Llamado por Step Functions (`WAIT_FOR_TASK_TOKEN`)
- Guarda `qualitiesTaskToken` en DynamoDB, lanza job de MediaConvert con 5 resoluciones HLS
- Runtime: Node.js 20.x, timeout: 30 s
- **Permisos**: `mediaconvert:CreateJob`, `iam:PassRole`, `s3:GetObject`, `dynamodb:UpdateItem`

### QualitiesCallback — `lambda/qualities/index.ts → callback`
- **Trigger**: EventBridge — `MediaConvert Job State Change` donde `userMetadata.branch = "qualities"`; estados: `COMPLETE`, `ERROR`, `CANCELED`
- Lee `qualitiesTaskToken` de DynamoDB → `SendTaskSuccess` o `SendTaskFailure`
- Runtime: Node.js 20.x, timeout: 10 s
- **Permisos**: `states:SendTaskSuccess`, `states:SendTaskFailure`, `dynamodb:GetItem`

### HighlightsLaunch — `lambda/highlights/index.ts → launch`
- Llamado por Step Functions (`WAIT_FOR_TASK_TOKEN`)
- Guarda `highlightsTaskToken` en DynamoDB, lanza job de MediaConvert con `InputClippings` (timestamps de Pegasus), output 720p
- Runtime: Node.js 20.x, timeout: 30 s
- **Permisos**: `mediaconvert:CreateJob`, `iam:PassRole`, `s3:GetObject`, `dynamodb:UpdateItem`

### HighlightsCallback — `lambda/highlights/index.ts → callback`
- **Trigger**: EventBridge — `MediaConvert Job State Change` donde `userMetadata.branch = "highlights"`; estados: `COMPLETE`, `ERROR`, `CANCELED`
- Lee `highlightsTaskToken` de DynamoDB → `SendTaskSuccess` o `SendTaskFailure`
- Runtime: Node.js 20.x, timeout: 10 s
- **Permisos**: `states:SendTaskSuccess`, `states:SendTaskFailure`, `dynamodb:GetItem`

> **Nota**: `lambda/twelvelabs/index.ts` existe en el repositorio pero **no está conectado** a ningún construct CDK. Es código vestigial de una iteración anterior.

---

## IAM — roles

### MediaConvert Role
- Trust policy: `mediaconvert.amazonaws.com`
- `s3:GetObject` y `s3:PutObject` en el bucket

### Step Functions Role (generado automáticamente por CDK)
- `lambda:InvokeFunction` sobre QualitiesLaunch y HighlightsLaunch
- `ecs:RunTask`, `ecs:StopTask`, `ecs:DescribeTasks`
- `iam:PassRole` sobre el task role y execution role de Fargate
- `dynamodb:PutItem`, `dynamodb:UpdateItem` sobre la tabla jobs

### Fargate Task Role
- `bedrock:InvokeModel`
- `states:SendTaskSuccess`, `states:SendTaskFailure`
- `s3:GetObject` en el bucket

---

## Servicios AWS

| Servicio | Rol |
|---|---|
| S3 (bucket único) | Input `input/` y output `output/{jobId}/` |
| Lambda (orchestrator) | Trigger S3 → crea DynamoDB item + inicia Step Function |
| Step Functions | Orquesta el pipeline completo (timeout 2 h) |
| DynamoDB | Estado del job + task tokens de MediaConvert |
| ECS Fargate | Corre el container Pegasus que invoca Bedrock |
| Bedrock (`twelvelabs.pegasus-1-2-v1:0`) | Análisis de video, devuelve timestamps de goles |
| MediaConvert | HLS multi-resolución (Branch A) + highlight reel 720p (Branch B) |
| EventBridge | Recibe fin de jobs MediaConvert → dispara Lambda callbacks |
| Lambda (callbacks) | `SendTaskSuccess`/`SendTaskFailure` a Step Functions |

---

## Estructura del repositorio

```
video-processor/
├── bin/
│   └── video-processor.ts
├── lib/
│   ├── stacks/
│   │   └── video-processor-stack.ts
│   ├── constructs/
│   │   ├── storage.ts               # S3 bucket único + DynamoDB
│   │   ├── lambdas.ts               # orchestrator + launch/callback qualities + launch/callback highlights
│   │   ├── mediaconvert-role.ts     # IAM role de MediaConvert
│   │   ├── state-machine.ts         # Step Function
│   │   ├── eventbridge-rules.ts     # reglas MediaConvert → callbacks
│   │   └── fargate-pegasus.ts       # VPC + Cluster + TaskDef + Container
│   └── step-functions/
│       └── definition.ts            # ASL de la Step Function (CDK)
├── lambda/
│   ├── orchestrator/index.ts
│   ├── qualities/index.ts           # handlers: launch, callback
│   ├── highlights/index.ts          # handlers: launch, callback
│   └── twelvelabs/index.ts          # ⚠ no conectado — código vestigial
├── fargate/
│   └── pegasus/
│       └── src/index.ts             # container: invoca Bedrock + SendTaskSuccess
├── cdk.json
└── package.json
```

---

## Deploy

Requiere la variable de entorno `BEDROCK_MODEL_ID` configurada antes de ejecutar `cdk deploy`.

```bash
export BEDROCK_MODEL_ID=twelvelabs.pegasus-1-2-v1:0
cdk deploy --context stage=dev
```
