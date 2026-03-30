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

    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: `video-processor-${stage}-jobs`,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });
  }
}
