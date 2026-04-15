import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface DefinitionProps {
  jobsTable: dynamodb.ITable;
  qualitiesLaunchFn: lambda.IFunction;
  highlightsLaunchFn: lambda.IFunction;
  pegasusCluster: ecs.ICluster;
  pegasusTaskDef: ecs.FargateTaskDefinition;
  pegasusContainer: ecs.ContainerDefinition;
  pegasusSecurityGroup: ec2.ISecurityGroup;
  bedrockModelId: string;
}

export function buildDefinition(scope: Construct, props: DefinitionProps): sfn.IChainable {
  const {
    jobsTable,
    qualitiesLaunchFn,
    highlightsLaunchFn,
    pegasusCluster,
    pegasusTaskDef,
    pegasusContainer,
    pegasusSecurityGroup,
    bedrockModelId,
  } = props;

  // ── RegisterStart ─────────────────────────────────────────────────────────────

  const registerStart = new tasks.DynamoPutItem(scope, 'RegisterStart', {
    table: jobsTable,
    item: {
      jobId:            tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')),
      qualitiesStatus:  tasks.DynamoAttributeValue.fromString('PENDING'),
      highlightsStatus: tasks.DynamoAttributeValue.fromString('PEGASUS'),
      outputVideo:      tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.outputVideo')),
      inputKey:         tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.inputKey')),
      createdAt:        tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.StartTime')),
    },
    resultPath: sfn.JsonPath.DISCARD,
  });

  // ── Branch A — Calidades ─────────────────────────────────────────────────────

  const launchQualities = new tasks.LambdaInvoke(scope, 'LaunchMediaConvertQualities', {
    lambdaFunction: qualitiesLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':   sfn.JsonPath.taskToken,
      'jobId.$':     '$.jobId',
      'inputKey.$':  '$.inputKey',
      'outputVideo.$': '$.outputVideo',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateQualitiesDone = new tasks.DynamoUpdateItem(scope, 'UpdateQualitiesDone', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET qualitiesStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('DONE') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateQualitiesFailed = new tasks.DynamoUpdateItem(scope, 'UpdateQualitiesFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET qualitiesStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  launchQualities.addCatch(updateQualitiesFailed, { errors: ['States.ALL'], resultPath: '$.error' });

  // const branchA = sfn.Chain.start(launchQualities).next(updateQualitiesDone); // BRANCH A — descomentar para reactivar
  const branchA = sfn.Chain.start(new sfn.Succeed(scope, 'SkipQualities')); // TEMPORAL — solo para testear Branch B

  // ── Branch B — Análisis + Highlight reel ─────────────────────────────────────

  const updateHighlightsFailed = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  }).next(new sfn.Succeed(scope, 'NoTimestamps'));

  const updateHighlightsToProcessing = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsStatus', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('HIGHLIGHTS') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const launchHighlights = new tasks.LambdaInvoke(scope, 'LaunchMediaConvertHighlight', {
    lambdaFunction: highlightsLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':     sfn.JsonPath.taskToken,
      'jobId.$':       '$.jobId',
      'inputKey.$':    '$.inputKey',
      'outputVideo.$': '$.outputVideo',
      'timestamps.$':  '$.pegasus.timestamps',
      'goals.$':       '$.pegasus.goals',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateHighlightsDone = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsDone', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('DONE') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateHighlightsFailedOnMediaConvert = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsFailedOnMediaConvert', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  launchHighlights.addCatch(updateHighlightsFailedOnMediaConvert, { errors: ['States.ALL'], resultPath: '$.error' });

  const checkTimestamps = new sfn.Choice(scope, 'CheckTimestamps')
    .when(
      sfn.Condition.isPresent('$.pegasus.timestamps[0]'),
      sfn.Chain.start(updateHighlightsToProcessing)
        .next(launchHighlights)
        .next(updateHighlightsDone),
    )
    .otherwise(updateHighlightsFailed);

  // ── Fargate — Pegasus ─────────────────────────────────────────────────────────

  const invokePegasus = new tasks.EcsRunTask(scope, 'InvokePegasus', {
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    cluster: pegasusCluster,
    taskDefinition: pegasusTaskDef,
    launchTarget: new tasks.EcsFargateLaunchTarget(),
    assignPublicIp: true,
    securityGroups: [pegasusSecurityGroup],
    containerOverrides: [{
      containerDefinition: pegasusContainer,
      environment: [
        { name: 'TASK_TOKEN', value: sfn.JsonPath.taskToken },
        { name: 'JOB_ID', value: sfn.JsonPath.stringAt('$.jobId') },
        { name: 'INPUT_KEY', value: sfn.JsonPath.stringAt('$.inputKey') },
        { name: 'BEDROCK_MODEL_ID', value: bedrockModelId },
      ],
    }],
    resultPath: '$.pegasus',
  });

  invokePegasus.addCatch(updateHighlightsFailed, { errors: ['States.ALL'], resultPath: '$.error' });

  const branchB = sfn.Chain.start(invokePegasus).next(checkTimestamps);

  // ── Parallel ──────────────────────────────────────────────────────────────────

  const parallel = new sfn.Parallel(scope, 'ParallelProcess');
  parallel.branch(branchA);
  parallel.branch(branchB);

  return sfn.Chain.start(registerStart).next(parallel);
}
