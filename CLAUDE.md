# Video Processor Project

## Arquitectura
Toda la infraestructura se despliega mediante AWS CDK con Nodejs y TypeScript.

## Resumen

Pipeline serverless en AWS CDK que recibe un video crudo en S3, lo procesa en dos branches paralelos mediante Step Functions, y produce dos outputs independientes: calidades de video en HLS y un highlight reel. El análisis de momentos clave se realiza con **Amazon Bedrock — modelo `twelvelabs.pegasus-1-2-v1:0`** en modo asíncrono. No se guardan clips intermedios — el highlight reel se genera en un único job de MediaConvert con múltiples `InputClippings`.

---

## Arquitectura general

### Flujo de entrada

1. El usuario sube un `.mp4` al **S3 Input Bucket**
2. El evento `s3:ObjectCreated` dispara la **Lambda orquestadora**
3. La Lambda genera un `jobId` (UUID), crea el item en DynamoDB, y llama a `StartExecution` en la Step Function

### Step Function — estructura general

```
RegisterStart
└── ParallelProcess (Parallel state)
    ├── Branch A — calidades de video
    └── Branch B — análisis + highlight reel
```

El Parallel state cierra cuando **ambos branches** terminan. Los branches son completamente independientes entre sí — si uno falla, el otro continúa.

---

## Branch A — Calidades de video

### Responsabilidad
Transcodear el video original a múltiples calidades en formato HLS.

### Pasos
1. Lanzar job de **MediaConvert** con `waitForTaskToken`
   - Input: `inputKey` del evento de entrada
   - Output: `{outputVideo}qualities/` en S3 Output
   - Formato: HLS adaptive bitrate (múltiples calidades + master playlist)
2. MediaConvert termina → EventBridge emite evento → **Lambda callback A** llama a `SendTaskSuccess`
3. Actualizar DynamoDB: `qualitiesStatus → DONE` (o `FAILED`)

### Estados de `qualitiesStatus`
```
PENDING → DONE | FAILED
```

---

## Branch B — Análisis + Highlight reel

### Responsabilidad
Analizar el video con Bedrock/Pegasus para obtener timestamps de momentos clave, luego generar un único highlight reel `.m3u8` con MediaConvert usando esos timestamps como `InputClippings`. No se guardan clips intermedios.

### Pasos en orden secuencial

#### Paso B1 — Bedrock `StartAsyncInvoke`
- Actualizar DynamoDB: `highlightsStatus → PEGASUS`
- Step Functions invoca **Bedrock** con SDK integration (`aws:bedrock:startAsyncInvoke`)
  - Modelo: `twelvelabs.pegasus-1-2-v1:0`
  - Input: referencia al video en S3 (`inputKey`)
  - Output: Bedrock escribe el resultado JSON en S3 (bucket temporal o mismo output bucket bajo `{outputVideo}tmp/`)
- Step Functions espera la finalización via `waitForTaskToken` + Lambda de polling, o polling nativo si el SDK integration lo soporta
- Cuando Bedrock termina, el estado recibe el array de timestamps

Formato esperado del output de Bedrock/Pegasus:
```json
[
  { "start": "00:32", "end": "00:45", "label": "gol" },
  { "start": "01:10", "end": "01:28", "label": "gol" }
]
```

#### Paso B2 — Validar timestamps (`Choice`)
- Si el array está vacío → `highlightsStatus → FAILED` con mensaje descriptivo
- Si tiene al menos un elemento → continuar al paso B3

#### Paso B3 — MediaConvert highlight reel (job único)
- Actualizar DynamoDB: `highlightsStatus → HIGHLIGHTS`
- Lanzar **un único job de MediaConvert** con `waitForTaskToken`
  - Todos los timestamps del paso anterior se pasan como `InputClippings` en secuencia dentro de un mismo job
  - MediaConvert ensambla los segmentos en orden y produce un único archivo
  - Output: `{outputVideo}highlights/highlight.m3u8`
  - No se generan ni guardan clips intermedios
  - `UserMetadata.taskToken` = token de Step Functions
  - `UserMetadata.branch` = `"highlights"`
- MediaConvert termina → EventBridge → **Lambda callback B** → `SendTaskSuccess`
- Actualizar DynamoDB: `highlightsStatus → DONE` (o `FAILED`)

### Estados de `highlightsStatus`
```
PEGASUS → HIGHLIGHTS → DONE | FAILED
```
`FAILED` puede ocurrir en cualquier transición y corta el branch.

---

## DynamoDB — Tabla `jobs`

| Campo | Tipo | Descripción |
|---|---|---|
| `jobId` | String (PK) | UUID generado por la Lambda orquestadora |
| `qualitiesStatus` | String | `PENDING` → `DONE` \| `FAILED` |
| `highlightsStatus` | String | `PEGASUS` → `HIGHLIGHTS` → `DONE` \| `FAILED` |
| `outputVideo` | String | Prefijo S3 base: `s3://output-bucket/jobId/` |
| `inputKey` | String | `s3://input-bucket/filename.mp4` |
| `createdAt` | String | ISO timestamp — usado para TTL |

### Notas
- Los timestamps de Pegasus **no se persisten** en DynamoDB — viven solo en la memoria de la ejecución de Step Functions
- Cada branch escribe únicamente sus propios campos con `UpdateItem` — sin riesgo de colisión
- TTL configurado sobre `createdAt` 

### Estructura de outputs en S3

```
s3://output-bucket/{jobId}/
├── qualities/
│   ├── 1080p.m3u8
│   ├── 720P.m3u8
│   ├── 480p.m3u8
│   ├── 360p.m3u8
│   └── 240p.m3u8
|
└── highlights/
    └── highlight.m3u8
```

---

## Servicios AWS involucrados

| Servicio | Rol |
|---|---|
| S3 (input) | Recibe el video crudo del usuario |
| S3 (output) | Almacena calidades HLS y highlight reel |
| Lambda (orquestadora) | Disparada por S3, crea item en DynamoDB, inicia Step Function |
| Step Functions | Orquesta el pipeline completo |
| DynamoDB | Registro de estado del job |
| Bedrock (`twelvelabs.pegasus-1-2-v1:0`) | Análisis del video en modo asíncrono, devuelve timestamps |
| MediaConvert | Transcodeo HLS (branch A) + highlight reel con InputClippings (branch B) |
| EventBridge | Recibe eventos de fin de job de MediaConvert |
| Lambda (callback A) | MediaConvert qualities → `SendTaskSuccess` |
| Lambda (callback B) | MediaConvert highlight → `SendTaskSuccess` |
| IAM | Roles para MediaConvert, Step Functions, Lambdas, Bedrock |


---

## Lambdas — detalle

### Lambda orquestadora
- **Trigger**: `s3:ObjectCreated` en input bucket
- **Acciones**:
  1. Genera `jobId` (UUID v4)
  2. Construye `outputVideo` = `s3://output-bucket/{jobId}/`
  3. Escribe item inicial en DynamoDB (`qualitiesStatus: PENDING`, `highlightsStatus: PEGASUS`)
  4. Llama a `StepFunctions.startExecution` con `{ jobId, inputKey, outputVideo }`
- **Permisos**: `dynamodb:PutItem`, `states:StartExecution`, `s3:GetObject` en input bucket

### Lambda callback A — MediaConvert qualities
- **Trigger**: EventBridge rule — `MediaConvert Job State Change`, filtrado por `UserMetadata.branch = "qualities"`
- **Acciones**: extrae `taskToken` de `UserMetadata` → `SendTaskSuccess` o `SendTaskFailure`
- **Permisos**: `states:SendTaskSuccess`, `states:SendTaskFailure`

### Lambda callback B — MediaConvert highlight
- **Trigger**: EventBridge rule — `MediaConvert Job State Change`, filtrado por `UserMetadata.branch = "highlights"`
- **Acciones**: extrae `taskToken` de `UserMetadata` → `SendTaskSuccess` o `SendTaskFailure`
- **Permisos**: `states:SendTaskSuccess`, `states:SendTaskFailure`

---

## Step Functions — definición de estados

```
RegisterStart (Task)
  → PutItem DynamoDB: qualitiesStatus=PENDING, highlightsStatus=PEGASUS

ParallelProcess (Parallel)
  │
  ├── BranchA
  │   ├── LaunchMediaConvertQualities (Task — waitForTaskToken)
  │   │     UserMetadata: { taskToken: $$.Task.Token, branch: "qualities" }
  │   │     Output: {outputVideo}qualities/
  │   └── UpdateQualitiesDone (Task — UpdateItem DynamoDB: qualitiesStatus=DONE)
  │
  └── BranchB
      ├── InvokePegasus (Task — Bedrock StartAsyncInvoke)
      │     modelo: twelvelabs.pegasus-1-2-v1:0
      │     input: { s3Uri: $.inputKey }
      │     outputLocation: {outputVideo}tmp/pegasus-result.json
      ├── CheckTimestamps (Choice)
      │     $.timestamps.length == 0 → UpdateHighlightsFailed
      │     $.timestamps.length > 0  → UpdateHighlightsStatus
      ├── UpdateHighlightsStatus (Task — UpdateItem DynamoDB: highlightsStatus=HIGHLIGHTS)
      ├── LaunchMediaConvertHighlight (Task — waitForTaskToken)
      │     InputClippings: todos los timestamps en secuencia (sin archivos intermedios)
      │     Output: {outputVideo}highlights/highlight.m3u8
      │     UserMetadata: { taskToken: $$.Task.Token, branch: "highlights" }
      └── UpdateHighlightsDone (Task — UpdateItem DynamoDB: highlightsStatus=DONE)
```

---

## IAM — roles necesarios

### Rol MediaConvert
- Trust policy: `mediaconvert.amazonaws.com`
- `s3:GetObject` en input bucket
- `s3:PutObject` en output bucket

### Rol Step Functions
- Trust policy: `states.amazonaws.com`
- `lambda:InvokeFunction` sobre Lambdas internas
- `bedrock:InvokeModel`, `bedrock:StartAsyncInvoke`
- `mediaconvert:CreateJob`
- `s3:GetObject`, `s3:PutObject` en output bucket

### Rol Lambdas (todas)
- `logs:CreateLogGroup`, `logs:CreateLogDelivery`, `logs:PutLogEvents`
- Permisos específicos por Lambda detallados arriba

---

## Estructura del repositorio CDK

```
video-processor/
├── bin/
│   └── video-processor.ts
├── lib/
│   ├── stacks/
│   │   └── video-processor-stack.ts
│   ├── constructs/
│   │   ├── storage.ts               # S3 buckets + DynamoDB
│   │   ├── lambdas.ts               # orquestadora + callbacks A y B
│   │   ├── mediaconvert-role.ts     # IAM role de MediaConvert
│   │   ├── state-machine.ts         # Step Function completa
│   │   └── eventbridge-rules.ts     # reglas para callbacks de MediaConvert
│   └── step-functions/
│       └── definition.ts            # ASL de la Step Function
├── lambda/
│   ├── orchestrator/
│   │   └── index.ts
│   ├── callback-qualities/
│   │   └── index.ts
│   └── callback-highlights/
│       └── index.ts
├── cdk.json
└── package.json
```
