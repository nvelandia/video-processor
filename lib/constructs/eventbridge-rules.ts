import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface EventBridgeRulesProps {
  stage:                  string;
  qualitiesCallbackFn:    lambda.IFunction;
  transcribeCallbackFn?:  lambda.IFunction;
  rekognitionCallbackFn?: lambda.IFunction;
  goalsHighlightCallbackFn?: lambda.IFunction;
}

export class EventBridgeRules extends Construct {
  constructor(scope: Construct, id: string, props: EventBridgeRulesProps) {
    super(scope, id);

    const {
      stage,
      qualitiesCallbackFn,
      transcribeCallbackFn,
      rekognitionCallbackFn,
      goalsHighlightCallbackFn,
    } = props;

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

    // Regla para Transcribe → branch goals (solo jobs con prefix goals__)
    if (transcribeCallbackFn) {
      new events.Rule(this, 'GoalsTranscribeRule', {
        ruleName: `video-processor-${stage}-transcribe-goals`,
        eventPattern: {
          source: ['aws.transcribe'],
          detailType: ['Transcribe Job State Change'],
          detail: {
            TranscriptionJobName:   [{ prefix: 'goals__' }],
            TranscriptionJobStatus: ['COMPLETED', 'FAILED'],
          },
        },
        targets: [new targets.LambdaFunction(transcribeCallbackFn)],
      });
    }

    // Regla para Rekognition → branch goals (ClientRequestToken con prefix goals__)
    if (rekognitionCallbackFn) {
      new events.Rule(this, 'GoalsRekognitionRule', {
        ruleName: `video-processor-${stage}-rekognition-goals`,
        eventPattern: {
          source: ['aws.rekognition'],
          detailType: ['Rekognition Video Analysis State Change'],
          detail: {
            ClientRequestToken: [{ prefix: 'goals__' }],
          },
        },
        targets: [new targets.LambdaFunction(rekognitionCallbackFn)],
      });
    }

    // Regla para MediaConvert → branch goals (highlight concat)
    if (goalsHighlightCallbackFn) {
      new events.Rule(this, 'GoalsMediaConvertRule', {
        ruleName: `video-processor-${stage}-mediaconvert-goals`,
        eventPattern: {
          source: ['aws.mediaconvert'],
          detailType: ['MediaConvert Job State Change'],
          detail: {
            status: ['COMPLETE', 'ERROR', 'CANCELED'],
            userMetadata: { branch: ['goals'] },
          },
        },
        targets: [new targets.LambdaFunction(goalsHighlightCallbackFn)],
      });
    }
  }
}
