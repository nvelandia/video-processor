import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { buildDefinition } from '../step-functions/definition';

export interface StateMachineConstructProps {
  stage:                string;
  jobsTable:            dynamodb.ITable;
  qualitiesLaunchFn:    lambda.IFunction;
  splitterFn:           lambda.IFunction;
  crowdNoiseFn:         lambda.IFunction;
  transcribeLaunchFn:   lambda.IFunction;
  rekognitionLaunchFn:  lambda.IFunction;
  fusionFn:             lambda.IFunction;
  highlightLaunchFn:    lambda.IFunction;
}

export class StateMachineConstruct extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StateMachineConstructProps) {
    super(scope, id);

    const {
      stage,
      jobsTable,
      qualitiesLaunchFn,
      splitterFn,
      crowdNoiseFn,
      transcribeLaunchFn,
      rekognitionLaunchFn,
      fusionFn,
      highlightLaunchFn,
    } = props;

    const definition = buildDefinition(this, {
      jobsTable,
      qualitiesLaunchFn,
      splitterFn,
      crowdNoiseFn,
      transcribeLaunchFn,
      rekognitionLaunchFn,
      fusionFn,
      highlightLaunchFn,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `video-processor-${stage}-pipeline`,
      definitionBody:   sfn.DefinitionBody.fromChainable(definition),
      timeout:          cdk.Duration.hours(4),
    });

    // tasks.LambdaInvoke ya concede invoke a la role de la state machine al construir
    // la definición, pero lo dejamos explícito para qualitiesLaunch (coherencia con código previo).
    qualitiesLaunchFn.grantInvoke(this.stateMachine.role);
    jobsTable.grantWriteData(this.stateMachine.role);
  }
}
