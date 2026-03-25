import { MediaConvertClient, CreateJobCommand } from '@aws-sdk/client-mediaconvert';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';

const mediaConvert = new MediaConvertClient({ endpoint: process.env.MEDIACONVERT_ENDPOINT });
const sfnClient = new SFNClient({});

interface InputClipping {
  StartTimecode: string;
  EndTimecode: string;
}

// Llamado por Step Function con waitForTaskToken
export const launch = async (event: {
  taskToken: string;
  jobId: string;
  inputKey: string;
  outputVideo: string;
  timestamps: InputClipping[];
}): Promise<void> => {
  const { taskToken, jobId, inputKey, outputVideo, timestamps } = event;

  await mediaConvert.send(new CreateJobCommand({
    Role: process.env.MEDIACONVERT_ROLE_ARN,
    Settings: {
      Inputs: [{
        FileInput: inputKey,
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
    UserMetadata: { taskToken, branch: 'highlights', jobId },
  } as any));

  console.log(`MediaConvert highlights job creado para jobId=${jobId}`);
};

// Llamado por EventBridge cuando MediaConvert termina (branch=highlights)
export const callback = async (event: any): Promise<void> => {
  const detail = event.detail;
  const status: string = detail.status;
  const taskToken: string | undefined = detail.userMetadata?.taskToken;

  if (!taskToken) {
    console.error('No taskToken en userMetadata', JSON.stringify(detail));
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
