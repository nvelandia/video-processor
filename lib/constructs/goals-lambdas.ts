import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

// Toma variables de process.env (cargadas desde .env en el host de CDK) y solo
// las propaga al entorno de la Lambda si están definidas. Evita setear strings vacíos.
function pickEnv(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== '') result[k] = v;
  }
  return result;
}

export interface GoalsLambdasProps {
  stage:                 string;
  bucket:                s3.IBucket;
  jobsTable:             dynamodb.ITable;
  goalsEventsTable:      dynamodb.ITable;
  mediaConvertRoleArn:   string;
  mediaConvertEndpoint:  string;
}

export class GoalsLambdas extends Construct {
  readonly ffmpegLayer:          lambda.LayerVersion;
  readonly splitter:             nodejs.NodejsFunction;
  readonly crowdNoise:           nodejs.NodejsFunction;
  readonly transcribeLaunch:     nodejs.NodejsFunction;
  readonly transcribeCallback:   nodejs.NodejsFunction;
  readonly rekognitionLaunch:    nodejs.NodejsFunction;
  readonly rekognitionCallback:  nodejs.NodejsFunction;
  readonly fusion:               nodejs.NodejsFunction;
  readonly highlightLaunch:      nodejs.NodejsFunction;
  readonly highlightCallback:    nodejs.NodejsFunction;
  readonly rekognitionSnsTopic:  sns.Topic;
  readonly rekognitionRole:      iam.Role;

  constructor(scope: Construct, id: string, props: GoalsLambdasProps) {
    super(scope, id);
    const {
      stage,
      bucket,
      jobsTable,
      goalsEventsTable,
      mediaConvertRoleArn,
      mediaConvertEndpoint,
    } = props;

    // ── FFmpeg Layer ─────────────────────────────────────────────────────────────
    this.ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      layerVersionName: `video-processor-${stage}-ffmpeg`,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../layers/ffmpeg')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      description: 'ffmpeg and ffprobe static binaries for goal detection',
    });

    // ── Rekognition SNS + Role (requeridos por StartLabelDetection) ──────────────
    // StartLabelDetection requiere NotificationChannel (SNS + role que Rekognition asume).
    // No usamos el SNS para invocar el callback — EventBridge lo hace nativamente —
    // pero AWS exige declararlo.
    this.rekognitionSnsTopic = new sns.Topic(this, 'RekognitionSnsTopic', {
      topicName: `video-processor-${stage}-rekognition-completion`,
    });

    this.rekognitionRole = new iam.Role(this, 'RekognitionRole', {
      roleName: `video-processor-${stage}-rekognition-publish`,
      assumedBy: new iam.ServicePrincipal('rekognition.amazonaws.com'),
    });
    this.rekognitionSnsTopic.grantPublish(this.rekognitionRole);

    // ── Helper para declarar lambdas con el mismo estilo ─────────────────────────
    const baseEnv = {
      BUCKET:             bucket.bucketName,
      JOBS_TABLE:         jobsTable.tableName,
      GOALS_EVENTS_TABLE: goalsEventsTable.tableName,
    };

    const makeLambda = (
      id: string,
      functionName: string,
      entry: string,
      handler: string,
      opts: {
        timeout?:        cdk.Duration;
        memorySize?:     number;
        useFfmpegLayer?: boolean;
        env?:            Record<string, string>;
      } = {},
    ): nodejs.NodejsFunction => {
      return new nodejs.NodejsFunction(this, id, {
        functionName,
        runtime:      lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.X86_64,
        entry,
        handler,
        timeout:      opts.timeout    ?? cdk.Duration.seconds(30),
        memorySize:   opts.memorySize ?? 512,
        layers:       opts.useFfmpegLayer ? [this.ffmpegLayer] : undefined,
        environment:  { ...baseEnv, ...(opts.env ?? {}) },
        bundling:     { externalModules: ['@aws-sdk/*'] },
      });
    };

    // ── Splitter ─────────────────────────────────────────────────────────────────
    this.splitter = makeLambda(
      'GoalsSplitter',
      `video-processor-${stage}-goals-splitter`,
      path.join(__dirname, '../../lambda/goals/splitter/index.ts'),
      'handler',
      { timeout: cdk.Duration.seconds(30), useFfmpegLayer: true },
    );
    bucket.grantRead(this.splitter);
    jobsTable.grantWriteData(this.splitter);

    // ── Crowd Noise ──────────────────────────────────────────────────────────────
    this.crowdNoise = makeLambda(
      'GoalsCrowdNoise',
      `video-processor-${stage}-goals-crowd-noise`,
      path.join(__dirname, '../../lambda/goals/crowd-noise/index.ts'),
      'handler',
      { timeout: cdk.Duration.seconds(300), memorySize: 1024, useFfmpegLayer: true },
    );
    bucket.grantRead(this.crowdNoise);
    goalsEventsTable.grantWriteData(this.crowdNoise);

    // ── Transcribe (launch + callback) ───────────────────────────────────────────
    this.transcribeLaunch = makeLambda(
      'GoalsTranscribeLaunch',
      `video-processor-${stage}-goals-transcribe-launch`,
      path.join(__dirname, '../../lambda/goals/transcribe/index.ts'),
      'launch',
      {
        timeout: cdk.Duration.seconds(120),
        memorySize: 1024,
        useFfmpegLayer: true,
        env: pickEnv(['TRANSCRIBE_LANGUAGE']),
      },
    );
    bucket.grantRead(this.transcribeLaunch);
    bucket.grantPut(this.transcribeLaunch); // sube audio-chunks a tmp/
    goalsEventsTable.grantWriteData(this.transcribeLaunch);
    this.transcribeLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['transcribe:StartTranscriptionJob'],
      resources: ['*'],
    }));

    this.transcribeCallback = makeLambda(
      'GoalsTranscribeCallback',
      `video-processor-${stage}-goals-transcribe-callback`,
      path.join(__dirname, '../../lambda/goals/transcribe/index.ts'),
      'callback',
      {
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        env: pickEnv(['GOAL_KEYWORDS', 'GOAL_NEGATIVES']),
      },
    );
    goalsEventsTable.grantReadData(this.transcribeCallback);
    goalsEventsTable.grantWriteData(this.transcribeCallback);
    this.transcribeCallback.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'states:SendTaskSuccess',
        'states:SendTaskFailure',
        'transcribe:GetTranscriptionJob',
      ],
      resources: ['*'],
    }));

    // ── Rekognition (launch + callback) ──────────────────────────────────────────
    this.rekognitionLaunch = makeLambda(
      'GoalsRekognitionLaunch',
      `video-processor-${stage}-goals-rekognition-launch`,
      path.join(__dirname, '../../lambda/goals/rekognition/index.ts'),
      'launch',
      {
        timeout: cdk.Duration.seconds(30),
        env: {
          REKOGNITION_SNS_TOPIC: this.rekognitionSnsTopic.topicArn,
          REKOGNITION_ROLE_ARN:  this.rekognitionRole.roleArn,
        },
      },
    );
    bucket.grantRead(this.rekognitionLaunch); // Rekognition valida el objeto con las credenciales del caller
    goalsEventsTable.grantWriteData(this.rekognitionLaunch);
    this.rekognitionLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['rekognition:StartLabelDetection'],
      resources: ['*'],
    }));
    this.rekognitionLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['iam:PassRole'],
      resources: [this.rekognitionRole.roleArn],
    }));

    this.rekognitionCallback = makeLambda(
      'GoalsRekognitionCallback',
      `video-processor-${stage}-goals-rekognition-callback`,
      path.join(__dirname, '../../lambda/goals/rekognition/index.ts'),
      'callback',
      { timeout: cdk.Duration.seconds(60), memorySize: 512 },
    );
    goalsEventsTable.grantReadData(this.rekognitionCallback);
    goalsEventsTable.grantWriteData(this.rekognitionCallback);
    this.rekognitionCallback.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['states:SendTaskSuccess', 'states:SendTaskFailure', 'rekognition:GetLabelDetection'],
      resources: ['*'],
    }));

    // ── Fusion ───────────────────────────────────────────────────────────────────
    this.fusion = makeLambda(
      'GoalsFusion',
      `video-processor-${stage}-goals-fusion`,
      path.join(__dirname, '../../lambda/goals/fusion/index.ts'),
      'handler',
      {
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        env: pickEnv([
          'WINDOW_MS',
          'REACTION_DELAY_MS',
          'CLIP_BEFORE_MS',
          'CLIP_AFTER_MS',
          'MIN_GAP_MS',
          'MIN_SCORE',
          'METRICS_NAMESPACE',
        ]),
      },
    );
    // Query usa el GSI jobId-source-index — grantReadData sobre la tabla no cubre el índice,
    // hay que habilitarlo explícitamente.
    goalsEventsTable.grantReadData(this.fusion);
    this.fusion.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['dynamodb:Query'],
      resources: [`${goalsEventsTable.tableArn}/index/*`],
    }));
    jobsTable.grantWriteData(this.fusion);
    this.fusion.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // ── Highlight (launch + callback) ────────────────────────────────────────────
    const highlightEnv = {
      MEDIACONVERT_ENDPOINT: mediaConvertEndpoint,
      MEDIACONVERT_ROLE_ARN: mediaConvertRoleArn,
    };

    this.highlightLaunch = makeLambda(
      'GoalsHighlightLaunch',
      `video-processor-${stage}-goals-highlight-launch`,
      path.join(__dirname, '../../lambda/goals/highlight/index.ts'),
      'launch',
      { timeout: cdk.Duration.seconds(30), env: highlightEnv },
    );
    bucket.grantRead(this.highlightLaunch);
    bucket.grantPut(this.highlightLaunch);
    jobsTable.grantWriteData(this.highlightLaunch);
    this.highlightLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['mediaconvert:CreateJob', 'iam:PassRole'],
      resources: ['*'],
    }));
    this.highlightLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['states:SendTaskSuccess'],
      resources: ['*'],
    }));

    this.highlightCallback = makeLambda(
      'GoalsHighlightCallback',
      `video-processor-${stage}-goals-highlight-callback`,
      path.join(__dirname, '../../lambda/goals/highlight/index.ts'),
      'callback',
      { timeout: cdk.Duration.seconds(15) },
    );
    jobsTable.grantReadData(this.highlightCallback);
    jobsTable.grantWriteData(this.highlightCallback);
    this.highlightCallback.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));
  }
}
