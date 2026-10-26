import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { SERVICE_NAMES, type ServiceName } from '../services.js';

export interface EcrStackProps extends StackProps {
  cfg: StageConfig;
}

export type ImageName = ServiceName | 'tools';
export const IMAGE_NAMES: ImageName[] = [...SERVICE_NAMES, 'tools'];

/** `pro-cure-<stage>/<service>` — the deploy workflow pushes `<sha>`-tagged images here. */
export const repoName = (stage: string, image: ImageName) => `pro-cure-${stage}/${image}`;

/**
 * One ECR repository per backend service plus `tools` (migrations). Deployed first and on its own so
 * CI can push images before any ECS resource references a tag. Web is static (S3), so no repo.
 */
export class EcrStack extends Stack {
  readonly repos: Record<ImageName, ecr.Repository>;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const prod = cfg.stage === 'prod';
    this.repos = {} as Record<ImageName, ecr.Repository>;
    for (const image of IMAGE_NAMES) {
      const repo = new ecr.Repository(this, `${image}Repo`, {
        repositoryName: repoName(cfg.stage, image),
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        emptyOnDelete: !prod,
        lifecycleRules: [
          {
            description: 'Drop untagged layers',
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: Duration.days(7),
            rulePriority: 1,
          },
          {
            description: 'Keep the last N images',
            tagStatus: ecr.TagStatus.ANY,
            maxImageCount: prod ? 100 : 30,
            rulePriority: 2,
          },
        ],
      });
      this.repos[image] = repo;
    }
    new CfnOutput(this, 'RegistryUri', { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` });
    new CfnOutput(this, 'RepositoryPrefix', { value: `pro-cure-${cfg.stage}/` });
  }
}
