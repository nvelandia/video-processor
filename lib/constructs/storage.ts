import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageProps {
  stage: string;
}

export class Storage extends Construct {
  readonly inputBucket: s3.Bucket;
  readonly outputBucket: s3.Bucket;
  readonly jobsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const { stage } = props;

    this.inputBucket = new s3.Bucket(this, 'InputBucket', {
      bucketName: `video-processor-${stage}-input`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.outputBucket = new s3.Bucket(this, 'OutputBucket', {
      bucketName: `video-processor-${stage}-output`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: `video-processor-${stage}-jobs`,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });
  }
}
