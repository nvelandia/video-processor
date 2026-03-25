import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface MediaConvertRoleProps {
  stage: string;
  inputBucket: s3.IBucket;
  outputBucket: s3.IBucket;
}

export class MediaConvertRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: MediaConvertRoleProps) {
    super(scope, id);

    const { stage, inputBucket, outputBucket } = props;

    this.role = new iam.Role(this, 'Role', {
      roleName: `video-processor-${stage}-mediaconvert`,
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });

    inputBucket.grantRead(this.role);
    outputBucket.grantReadWrite(this.role);
  }
}
