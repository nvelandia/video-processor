# Video Processor Project

## Resumen

Pipeline serverless en AWS CDK (Node.js + TypeScript) que recibe un video crudo en S3, lo procesa mediante Step Functions, y produce HLS multi-resolución (5 calidades). El transcoding se realiza con **AWS MediaConvert**.

---

## Infraestructura general

### S3 — bucket único

Un solo bucket: `video-processor-{stage}-media`

```
s3://video-processor-{stage}-media/
├── input/          ← videos crudos subidos por el usuario (.mp4)
└── output/{jobId}/
    └── qualities/  ← HLS multi-resolución (5 calidades)
```

El trigger de S3 filtra por `prefix: input/` y `suffix: .mp4`.

### Flujo de entrada

1. El usuario sube un `.mp4` a `input/` del bucket
2. `s3:ObjectCreated` dispara la **Lambda orquestadora**
3. La Lambda genera un `jobId` = `{filename}-{UUIDv4}`, crea el item en DynamoDB, e inicia la Step Function

---

## Step Function — estructura

```
RegisterStart (DynamoPutItem)
└── LaunchMediaConvertQualities (LambdaInvoke WAIT_FOR_TASK_TOKEN)
    └── UpdateQualitiesDone (DynamoUpdateItem)
```

En caso de error en MediaConvert: **UpdateQualitiesFailed** (`qualitiesStatus = FAILED`). Timeout total: **2 horas**.

---

## Calidades de video

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

### Estados de `qualitiesStatus`
```
PENDING → DONE | FAILED
```

---

## DynamoDB — Tabla `video-processor-{stage}-jobs`

| Campo | Tipo | Descripción |
|---|---|---|
| `jobId` | String (PK) | `{filename}-{UUIDv4}` |
| `qualitiesStatus` | String | `PENDING` → `DONE` \| `FAILED` |
| `outputVideo` | String | `s3://{bucket}/output/{jobId}/` |
| `inputKey` | String | `s3://{bucket}/input/{filename}.mp4` |
| `createdAt` | String | ISO timestamp (referencia) |
| `ttl` | Number | Unix timestamp = `now + 7 días` — atributo TTL de DynamoDB |
| `qualitiesTaskToken` | String | Task token de Step Functions para callback de qualities |

### Notas
- Los task tokens se guardan en DynamoDB porque `UserMetadata` de MediaConvert tiene límite de 256 caracteres
- Billing mode: `PAY_PER_REQUEST`

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

---

## IAM — roles

### MediaConvert Role
- Trust policy: `mediaconvert.amazonaws.com`
- `s3:GetObject` y `s3:PutObject` en el bucket

### Step Functions Role (generado automáticamente por CDK)
- `lambda:InvokeFunction` sobre QualitiesLaunch
- `dynamodb:PutItem`, `dynamodb:UpdateItem` sobre la tabla jobs

---

## Servicios AWS

| Servicio | Rol |
|---|---|
| S3 (bucket único) | Input `input/` y output `output/{jobId}/` |
| Lambda (orchestrator) | Trigger S3 → crea DynamoDB item + inicia Step Function |
| Step Functions | Orquesta el pipeline completo (timeout 2 h) |
| DynamoDB | Estado del job + task tokens de MediaConvert |
| MediaConvert | HLS multi-resolución (5 calidades) |
| EventBridge | Recibe fin de jobs MediaConvert → dispara Lambda callback |
| Lambda (callback) | `SendTaskSuccess`/`SendTaskFailure` a Step Functions |

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
│   │   ├── lambdas.ts               # orchestrator + launch/callback qualities
│   │   ├── mediaconvert-role.ts     # IAM role de MediaConvert
│   │   ├── state-machine.ts         # Step Function
│   │   └── eventbridge-rules.ts     # regla MediaConvert → callback
│   └── step-functions/
│       └── definition.ts            # ASL de la Step Function (CDK)
├── lambda/
│   ├── orchestrator/index.ts
│   └── qualities/index.ts           # handlers: launch, callback
├── cdk.json
└── package.json
```

---

## Deploy

```bash
cdk deploy --context stage=dev
```
