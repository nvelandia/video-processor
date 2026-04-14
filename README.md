# Video Processor

Pipeline serverless en AWS para procesar videos de partidos de fútbol. Cuando se sube un video crudo a S3, el sistema genera automáticamente dos outputs en paralelo: el video en múltiples calidades HLS y un highlight reel con los goles del partido.

## Cómo funciona

1. El usuario sube un `.mp4` a `s3://video-processor-{stage}-media/input/`
2. Se dispara automáticamente una Step Function que procesa el video en dos branches paralelos:

**Branch A — Calidades de video**
MediaConvert transcodifica el video a 5 resoluciones HLS (1080p, 720p, 480p, 360p, 240p).

**Branch B — Highlights**
Un contenedor Fargate invoca Amazon Bedrock con el modelo `twelvelabs.pegasus-1-2-v1:0` para detectar los goles del partido y obtener sus timestamps. Luego MediaConvert genera un highlight reel en 720p concatenando solo esos momentos.

Los outputs quedan en `s3://video-processor-{stage}-media/output/{jobId}/`.

## Stack

- **AWS CDK** (TypeScript) — infraestructura como código
- **Step Functions** — orquestación del pipeline
- **Lambda** — orquestador + callbacks de MediaConvert
- **ECS Fargate** — container que invoca Bedrock
- **Amazon Bedrock** — análisis de video con Pegasus
- **MediaConvert** — transcodificación HLS y highlight reel
- **DynamoDB** — estado del job y task tokens
- **EventBridge** — dispara callbacks al terminar MediaConvert

## Deploy

```bash
export BEDROCK_MODEL_ID=twelvelabs.pegasus-1-2-v1:0
cdk deploy --context stage=dev
```

## Otros comandos

```bash
npx cdk diff     # Preview de cambios
npx cdk destroy  # Eliminar stack
```
