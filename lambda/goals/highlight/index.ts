import { MediaConvertClient, CreateJobCommand } from '@aws-sdk/client-mediaconvert';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const mc  = new MediaConvertClient({ endpoint: process.env.MEDIACONVERT_ENDPOINT });
const sfn = new SFNClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface GoalClip {
  goalMs:      number;
  clipStartMs: number;
  clipEndMs:   number;
  confirmedBy: string[];
  score:       number;
}

export interface LaunchEvent {
  taskToken: string;
  jobId:     string;
  inputKey:  string;
  fps:       number;
  goals:     GoalClip[];
}

// ──────────────────────────────────────────────────────────────────────────────
// launch: invocado por Step Functions WAIT_FOR_TASK_TOKEN
// Concatena los clips en un único highlight.mp4
// ──────────────────────────────────────────────────────────────────────────────
export const launch = async (event: LaunchEvent): Promise<void> => {
  const { taskToken, jobId, inputKey, fps, goals } = event;

  // Caso sin goles: cerrar el estado sin lanzar MediaConvert
  if (!goals || goals.length === 0) {
    await ddb.send(new UpdateCommand({
      TableName: process.env.JOBS_TABLE as string,
      Key: { jobId },
      UpdateExpression: 'SET goalsStatus = :s, goalsCount = :c',
      ExpressionAttributeValues: { ':s': 'DONE', ':c': 0 },
    }));
    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ noGoals: true }),
    }));
    console.log(`highlight launch job=${jobId} noGoals`);
    return;
  }

  await ddb.send(new UpdateCommand({
    TableName: process.env.JOBS_TABLE as string,
    Key: { jobId },
    UpdateExpression: 'SET goalsTaskToken = :t',
    ExpressionAttributeValues: { ':t': taskToken },
  }));

  const fileInput = inputKey.startsWith('s3://')
    ? inputKey
    : `s3://${process.env.BUCKET}/${inputKey}`;

  const bucket      = process.env.BUCKET as string;
  const destination = `s3://${bucket}/output/${jobId}/goals/`;

  const inputClippings = goals.map(g => ({
    StartTimecode: msToTimecode(g.clipStartMs, fps),
    EndTimecode:   msToTimecode(g.clipEndMs,   fps),
  }));

  await mc.send(new CreateJobCommand({
    Role: process.env.MEDIACONVERT_ROLE_ARN,
    UserMetadata: { branch: 'goals', jobId },
    Settings: {
      Inputs: [{
        FileInput: fileInput,
        InputClippings: inputClippings,
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
      }],
      OutputGroups: [{
        Name: 'Goals Highlight',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: destination },
        },
        Outputs: [{
          NameModifier: '_highlight',
          ContainerSettings: { Container: 'MP4' },
          VideoDescription: {
            Width: 1920,
            Height: 1080,
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: { MaxBitrate: 5000000, RateControlMode: 'QVBR' },
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
  } as any));

  console.log(`highlight launched job=${jobId} clips=${goals.length}`);
};

// ──────────────────────────────────────────────────────────────────────────────
// callback: invocado por EventBridge cuando MediaConvert termina (branch=goals)
// ──────────────────────────────────────────────────────────────────────────────
export const callback = async (event: any): Promise<void> => {
  const detail = event.detail ?? {};
  if (detail.userMetadata?.branch !== 'goals') return;

  const jobId: string | undefined = detail.userMetadata?.jobId;
  if (!jobId) {
    console.error('goals callback without jobId in userMetadata');
    return;
  }

  const result = await ddb.send(new GetCommand({
    TableName: process.env.JOBS_TABLE as string,
    Key: { jobId },
    ProjectionExpression: 'goalsTaskToken',
  }));
  const taskToken: string | undefined = result.Item?.goalsTaskToken;
  if (!taskToken) {
    console.error(`no goalsTaskToken for jobId=${jobId}`);
    return;
  }

  const status: string = detail.status;

  if (status === 'COMPLETE') {
    await ddb.send(new UpdateCommand({
      TableName: process.env.JOBS_TABLE as string,
      Key: { jobId },
      UpdateExpression: 'SET goalsStatus = :s, goalsOutputKey = :o',
      ExpressionAttributeValues: {
        ':s': 'DONE',
        ':o': `output/${jobId}/goals/highlight.mp4`,
      },
    }));
    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ goalsStatus: 'DONE' }),
    }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: process.env.JOBS_TABLE as string,
      Key: { jobId },
      UpdateExpression: 'SET goalsStatus = :s',
      ExpressionAttributeValues: { ':s': 'FAILED' },
    }));
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'MediaConvertFailed',
      cause: `MediaConvert goals status=${status}`,
    }));
  }
};

// Formato SMPTE HH:MM:SS:FF que exige MediaConvert en InputClippings
function msToTimecode(ms: number, fps: number): string {
  const totalFrames = Math.round((ms / 1000) * fps);
  const frames      = totalFrames % Math.round(fps);
  const totalSec    = Math.floor(totalFrames / Math.round(fps));
  const seconds     = totalSec % 60;
  const minutes     = Math.floor(totalSec / 60) % 60;
  const hours       = Math.floor(totalSec / 3600);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}
