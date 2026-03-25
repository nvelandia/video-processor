import { MediaConvertClient, CreateJobCommand } from '@aws-sdk/client-mediaconvert';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';

const mediaConvert = new MediaConvertClient({ endpoint: process.env.MEDIACONVERT_ENDPOINT });
const sfnClient = new SFNClient({});

const resolutions = [
  { name: '_1080p', width: 1920, height: 1080, bitrate: 5000000 },
  { name: '_720p',  width: 1280, height: 720,  bitrate: 2500000 },
  { name: '_480p',  width: 854,  height: 480,  bitrate: 1200000 },
  { name: '_360p',  width: 640,  height: 360,  bitrate:  800000 },
  { name: '_240p',  width: 426,  height: 240,  bitrate:  400000 },
];

const outputsConfigs = resolutions.map(res => ({
  NameModifier: res.name,
  ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
  VideoDescription: {
    Width: res.width,
    Height: res.height,
    CodecSettings: {
      Codec: 'H_264',
      H264Settings: { MaxBitrate: res.bitrate, RateControlMode: 'QVBR' },
    },
  },
  AudioDescriptions: [{
    CodecSettings: {
      Codec: 'AAC',
      AacSettings: { Bitrate: 96000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
    },
  }],
}));

// Llamado por Step Function con waitForTaskToken
export const launch = async (event: {
  taskToken: string;
  jobId: string;
  inputKey: string;
  outputVideo: string;
}): Promise<void> => {
  const { taskToken, jobId, inputKey, outputVideo } = event;

  await mediaConvert.send(new CreateJobCommand({
    Role: process.env.MEDIACONVERT_ROLE_ARN,
    Settings: {
      Inputs: [{
        FileInput: inputKey,
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
      }],
      OutputGroups: [{
        Name: 'Apple HLS',
        OutputGroupSettings: {
          Type: 'HLS_GROUP_SETTINGS',
          HlsGroupSettings: {
            Destination: `${outputVideo}qualities/`,
            SegmentLength: 6,
            MinSegmentLength: 0,
          },
        },
        Outputs: outputsConfigs as any,
      }],
    },
    UserMetadata: { taskToken, branch: 'qualities', jobId },
  } as any));

  console.log(`MediaConvert qualities job creado para jobId=${jobId}`);
};

// Llamado por EventBridge cuando MediaConvert termina (branch=qualities)
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
      output: JSON.stringify({ qualitiesStatus: 'DONE' }),
    }));
  } else {
    await sfnClient.send(new SendTaskFailureCommand({
      taskToken,
      error: 'MediaConvertFailed',
      cause: `MediaConvert qualities terminó con status: ${status}`,
    }));
  }
};
