import { MediaConvertClient, CreateJobCommand } from '@aws-sdk/client-mediaconvert';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const mediaConvert = new MediaConvertClient({ endpoint: process.env.MEDIACONVERT_ENDPOINT });
const sfnClient = new SFNClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface InputClipping {
  StartTimecode: string;
  EndTimecode: string;
}

interface Goal {
  start: string;
  goal_moment?: string;
  end: string;
  label: string;
}

// Llamado por Step Function con waitForTaskToken
export const launch = async (event: {
  taskToken: string;
  jobId: string;
  inputKey: string;
  outputVideo: string;
  timestamps: InputClipping[];
  goals: Goal[];
}): Promise<void> => {
  const { taskToken, jobId, inputKey, outputVideo, timestamps, goals } = event;

  // Guardar taskToken y goals en DynamoDB
  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE_NAME,
    Key: { jobId },
    UpdateExpression: 'SET highlightsTaskToken = :t, goals = :g',
    ExpressionAttributeValues: {
      ':t': taskToken,
      ':g': goals,
    },
  }));

  await mediaConvert.send(new CreateJobCommand({
    Role: process.env.MEDIACONVERT_ROLE_ARN,
    Settings: {
      Inputs: [{
        FileInput: inputKey,
        TimecodeSource: 'ZEROBASED',
        InputClippings: timestamps,
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
      }],
      OutputGroups: [{
        Name: 'Apple HLS',
        OutputGroupSettings: {
          Type: 'HLS_GROUP_SETTINGS',
          HlsGroupSettings: {
            Destination: `${outputVideo}highlights/`,
            SegmentLength: 6,
            MinSegmentLength: 0,
          },
        },
        Outputs: [{
          NameModifier: '_highlight',
          ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
          VideoDescription: {
            Width: 1280,
            Height: 720,
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: { MaxBitrate: 2500000, RateControlMode: 'QVBR' },
            },
          },
          AudioDescriptions: [{
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: { Bitrate: 96000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
            },
          }],
        }],
      }],
    },
    UserMetadata: { branch: 'highlights', jobId },
  } as any));

  console.log(`MediaConvert highlights job creado para jobId=${jobId}`);
};

// Llamado por EventBridge cuando MediaConvert termina (branch=highlights)
export const callback = async (event: any): Promise<void> => {
  const detail = event.detail;
  const status: string = detail.status;
  const jobId: string | undefined = detail.userMetadata?.jobId;

  if (!jobId) {
    console.error('No jobId en userMetadata', JSON.stringify(detail));
    return;
  }

  const result = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_NAME,
    Key: { jobId },
    ProjectionExpression: 'highlightsTaskToken',
  }));

  const taskToken: string | undefined = result.Item?.highlightsTaskToken;

  if (!taskToken) {
    console.error(`No highlightsTaskToken en DynamoDB para jobId=${jobId}`);
    return;
  }

  if (status === 'COMPLETE') {
    await sfnClient.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ highlightsStatus: 'DONE' }),
    }));
  } else {
    await sfnClient.send(new SendTaskFailureCommand({
      taskToken,
      error: 'MediaConvertFailed',
      cause: `MediaConvert highlights terminó con status: ${status}`,
    }));
  }
};
