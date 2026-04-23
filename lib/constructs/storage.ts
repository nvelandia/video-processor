import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageProps {
  stage: string;
}

export class Storage extends Construct {
  readonly bucket: s3.Bucket;
  readonly jobsTable: dynamodb.Table;
  readonly goalsEventsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const { stage } = props;

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `video-processor-${stage}-media`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Bedrock necesita leer el video del bucket para InvokeModel
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
      resources: [this.bucket.arnForObjects('input/*')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Stack.of(scope).account },
      },
    }));

    // Lifecycle: audio chunks temporales de Transcribe se purgan a las 48h
    this.bucket.addLifecycleRule({
      id: 'CleanupTmpAudioChunks',
      prefix: 'tmp/',
      expiration: cdk.Duration.days(2),
    });

    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: `video-processor-${stage}-jobs`,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Eventos de señales de la branch de goals (crowd-noise, keyword, visual, task_token)
    // TTL de 24h para limpieza automática. Tabla separada de jobs porque 1 partido puede generar 500-2000 eventos.
    this.goalsEventsTable = new dynamodb.Table(this, 'GoalsEventsTable', {
      tableName: `video-processor-${stage}-goals-events`,
      partitionKey: { name: 'jobId',   type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'eventId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    this.goalsEventsTable.addGlobalSecondaryIndex({
      indexName: 'jobId-source-index',
      partitionKey: { name: 'jobId',  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'source', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
