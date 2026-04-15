import * as cdk from 'aws-cdk-lib';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';
import { Storage } from '../constructs/storage';
import { MediaConvertRole } from '../constructs/mediaconvert-role';
import { StateMachineConstruct } from '../constructs/state-machine';
import { Lambdas } from '../constructs/lambdas';
import { EventBridgeRules } from '../constructs/eventbridge-rules';

export class VideoProcessorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stage: string = this.node.tryGetContext('stage') ?? 'dev';

    // ── Storage ──────────────────────────────────────────────────────────────────
    const storage = new Storage(this, 'Storage', { stage });

    // ── MediaConvert IAM Role ────────────────────────────────────────────────────
    const mediaConvertRole = new MediaConvertRole(this, 'MediaConvertRole', {
      stage,
      bucket: storage.bucket,
    });

    // ── Step Function (necesita Lambdas; se crea en dos pasos) ───────────────────
    const preStateLambdas: Lambdas = new Lambdas(this, 'Lambdas', {
      stage,
      bucket: storage.bucket,
      jobsTable: storage.jobsTable,
      mediaConvertRoleArn: mediaConvertRole.role.roleArn,
      mediaConvertEndpoint: `https://mediaconvert.${this.region}.amazonaws.com`,
      stateMachineArn: cdk.Lazy.string({ produce: (): string => stateMachineConstruct.stateMachine.stateMachineArn }),
    });

    const stateMachineConstruct: StateMachineConstruct = new StateMachineConstruct(this, 'StateMachine', {
      stage,
      jobsTable: storage.jobsTable,
      qualitiesLaunchFn: preStateLambdas.qualitiesLaunch,
    });

    // ── EventBridge Rules ────────────────────────────────────────────────────────
    new EventBridgeRules(this, 'EventBridgeRules', {
      stage,
      qualitiesCallbackFn: preStateLambdas.qualitiesCallback,
    });

    // ── S3 trigger → orchestrator (solo archivos en input/) ───────────────────────
    storage.bucket.addEventNotification(
      cdk.aws_s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(preStateLambdas.orchestrator),
      { prefix: 'input/', suffix: '.mp4' },
    );
  }
}
