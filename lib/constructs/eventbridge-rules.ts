import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface EventBridgeRulesProps {
  stage: string;
  qualitiesCallbackFn: lambda.IFunction;
}

export class EventBridgeRules extends Construct {
  constructor(scope: Construct, id: string, props: EventBridgeRulesProps) {
    super(scope, id);

    const { stage, qualitiesCallbackFn } = props;

    // Regla para MediaConvert → branch qualities
    new events.Rule(this, 'QualitiesRule', {
      ruleName: `video-processor-${stage}-mediaconvert-qualities`,
      eventPattern: {
        source: ['aws.mediaconvert'],
        detailType: ['MediaConvert Job State Change'],
        detail: {
          status: ['COMPLETE', 'ERROR', 'CANCELED'],
          userMetadata: { branch: ['qualities'] },
        },
      },
      targets: [new targets.LambdaFunction(qualitiesCallbackFn)],
    });
  }
}
