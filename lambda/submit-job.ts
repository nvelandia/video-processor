import { MediaConvertClient, CreateJobCommand, CreateJobCommandInput } from "@aws-sdk/client-mediaconvert";

const client = new MediaConvertClient({
  endpoint: process.env.MEDIACONVERT_ENDPOINT as string,
});

export const handler = async (event: any) => {
  console.log("Evento recibido:", JSON.stringify(event, null, 2));

  try {
    const record = event.Records[0];
    const sourceBucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // Casteamos las variables de entorno a string
    const destinationBucket = process.env.VIDEO_BUCKET as string;
    const outputPrefix = process.env.OUTPUT_PREFIX as string;
    const roleArn = process.env.MEDIACONVERT_ROLE_ARN as string;

    const fileNameMatch = key.match(/([^\/]+)(?=\.\w+$)/);
    const baseFileName = fileNameMatch ? fileNameMatch[0] : 'video';

    const resolutions = [
      { name: "_1080p", width: 1920, height: 1080, bitrate: 5000000 },
      { name: "_720p", width: 1280, height: 720, bitrate: 2500000 },
      { name: "_480p", width: 854, height: 480, bitrate: 1200000 },
      { name: "_360p", width: 640, height: 360, bitrate: 800000 },
      { name: "_240p", width: 426, height: 240, bitrate: 400000 },
    ];

    const outputsConfigs = resolutions.map(res => ({
      NameModifier: res.name,
      ContainerSettings: { Container: "MP4" },
      VideoDescription: {
        Width: res.width,
        Height: res.height,
        CodecSettings: {
          Codec: "H_264",
          H264Settings: { MaxBitrate: res.bitrate, RateControlMode: "QVBR" },
        },
      },
      AudioDescriptions: [
        { 
          CodecSettings: { 
            Codec: "AAC", 
            AacSettings: { Bitrate: 96000, CodingMode: "CODING_MODE_2_0", SampleRate: 48000 } 
          } 
        }
      ]
    }));

    // Usamos 'as unknown as CreateJobCommandInput' para evitar que TS 
    // pelee con los tipos literales estrictos del SDK de MediaConvert
    const params = {
      Role: roleArn,
      Settings: {
        Inputs: [
          {
            FileInput: `s3://${sourceBucket}/${key}`,
            AudioSelectors: {
              "Audio Selector 1": { DefaultSelection: "DEFAULT" }
            }
          }
        ],
        OutputGroups: [
          {
            Name: "File Group",
            OutputGroupSettings: {
              Type: "FILE_GROUP_SETTINGS",
              FileGroupSettings: {
                Destination: `s3://${destinationBucket}/${outputPrefix}${baseFileName}/`,
              },
            },
            Outputs: outputsConfigs,
          },
        ],
      },
    } as unknown as CreateJobCommandInput;

    const command = new CreateJobCommand(params);
    const response = await client.send(command);
    
    console.log("Job de MediaConvert creado exitosamente. ID:", response.Job?.Id);
    return { statusCode: 200, body: `Job creado para ${baseFileName}` };

  } catch (error) {
    console.error("Error al procesar el video:", error);
    throw error;
  }
};