import codebuild = require('@aws-cdk/aws-codebuild')
import codepipeline = require('@aws-cdk/aws-codepipeline')
import {
  CodeBuildAction,
  GitHubSourceAction,
  GitHubTrigger,
  ManualApprovalAction,
} from '@aws-cdk/aws-codepipeline-actions'
import { Role, ServicePrincipal } from '@aws-cdk/aws-iam'
import sns = require('@aws-cdk/aws-sns')
import cdk = require('@aws-cdk/core')
import { SecretValue } from '@aws-cdk/core'
import { ArtifactBucket, PipelineNotifications, SlackApproval } from '@ndlib/ndlib-cdk'
import IlliadGatewayBuildProject from './illiad-gateway-build-project'
import IlliadGatewayBuildRole from './illiad-gateway-build-role'

const stages = ['test', 'prod']

export interface IIlliadGatewayPipelineStackProps extends cdk.StackProps {
  readonly gitOwner: string
  readonly gitTokenPath: string
  readonly serviceRepository: string
  readonly serviceBranch: string
  readonly blueprintsRepository: string
  readonly blueprintsBranch: string
  readonly emailReceivers: string
  readonly slackNotifyStackName?: string
  // Following props needed for build project
  readonly contact: string
  readonly owner: string
  readonly sentryTokenPath: string
  readonly sentryOrg: string
  readonly sentryProject: string
  readonly secretsPath: string
}

export default class IlliadGatewayPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: IIlliadGatewayPipelineStackProps) {
    super(scope, id, props)

    // S3 BUCKET FOR STORING ARTIFACTS
    const artifactBucket = new ArtifactBucket(this, 'ArtifactBucket', {})

    // IAM ROLES
    const codepipelineRole = new Role(this, 'CodePipelineRole', {
      assumedBy: new ServicePrincipal('codepipeline.amazonaws.com'),
    })
    const codebuildRole = new IlliadGatewayBuildRole(this, 'CodeBuildTrustRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
      stages,
      artifactBucket,
    })

    // CREATE PIPELINE
    const pipeline = new codepipeline.Pipeline(this, 'CodePipeline', {
      artifactBucket,
      role: codepipelineRole,
    })
    new PipelineNotifications(this, 'PipelineNotifications', {
      pipeline,
      receivers: props.emailReceivers,
    })

    // SOURCE CODE AND BLUEPRINTS
    const appSourceArtifact = new codepipeline.Artifact('AppCode')
    const appSourceAction = new GitHubSourceAction({
      actionName: 'SourceAppCode',
      owner: props.gitOwner,
      repo: props.serviceRepository,
      branch: props.serviceBranch,
      oauthToken: SecretValue.secretsManager(props.gitTokenPath, { jsonField: 'oauth' }),
      output: appSourceArtifact,
      trigger: GitHubTrigger.WEBHOOK,
    })
    const infraSourceArtifact = new codepipeline.Artifact('InfraCode')
    const infraSourceAction = new GitHubSourceAction({
      actionName: 'SourceInfraCode',
      owner: props.gitOwner,
      repo: props.blueprintsRepository,
      branch: props.blueprintsBranch,
      oauthToken: SecretValue.secretsManager(props.gitTokenPath, { jsonField: 'oauth' }),
      output: infraSourceArtifact,
      trigger: GitHubTrigger.NONE,
    })
    pipeline.addStage({
      stageName: 'Source',
      actions: [appSourceAction, infraSourceAction],
    })

    const actionEnvironment = {
      VERSION: {
        value: appSourceAction.variables.commitId,
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
      },
    }

    // DEPLOY TO TEST
    const deployToTestProject = new IlliadGatewayBuildProject(this, 'IlliadGatewayTestBuildProject', {
      ...props,
      stage: 'test',
      role: codebuildRole,
    })
    const deployToTestAction = new CodeBuildAction({
      actionName: 'Build_and_Deploy',
      project: deployToTestProject,
      input: appSourceArtifact,
      extraInputs: [infraSourceArtifact],
      runOrder: 1,
      environmentVariables: actionEnvironment,
    })

    // APPROVAL
    const approvalTopic = new sns.Topic(this, 'PipelineApprovalTopic', {
      displayName: 'PipelineApprovalTopic',
    })
    const manualApprovalAction = new ManualApprovalAction({
      actionName: 'ManualApprovalOfTestEnvironment',
      notificationTopic: approvalTopic,
      additionalInformation: 'Approve or Reject this change after testing',
      runOrder: 99, // Approval should always be last
    })
    if (props.slackNotifyStackName) {
      new SlackApproval(this, 'SlackApproval', {
        approvalTopic,
        notifyStackName: props.slackNotifyStackName,
      })
    }

    // TEST STAGE
    pipeline.addStage({
      stageName: 'DeployToTest',
      actions: [deployToTestAction, manualApprovalAction],
    })

    // DEPLOY TO PROD
    const deployToProdProject = new IlliadGatewayBuildProject(this, 'IlliadGatewayProdBuildProject', {
      ...props,
      stage: 'prod',
      role: codebuildRole,
    })
    const deployToProdAction = new CodeBuildAction({
      actionName: 'Build_and_Deploy',
      project: deployToProdProject,
      input: appSourceArtifact,
      extraInputs: [infraSourceArtifact],
      environmentVariables: actionEnvironment,
    })

    // PROD STAGE
    pipeline.addStage({
      stageName: 'DeployToProd',
      actions: [deployToProdAction],
    })
  }
}
