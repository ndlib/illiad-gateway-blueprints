import * as cdk from '@aws-cdk/core'
import { SecretValue } from '@aws-cdk/core'
import apigateway = require('@aws-cdk/aws-apigateway')
import lambda = require('@aws-cdk/aws-lambda')
import { RetentionDays } from '@aws-cdk/aws-logs'
import { StringParameter } from '@aws-cdk/aws-ssm'

export interface IIlliadGatewayStackProps extends cdk.StackProps {
  readonly stage: string
  readonly lambdaCodePath: string
  readonly sentryProject: string
  readonly sentryVersion: string
  readonly secretsPath: string
}

export default class IlliadGatewayStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: IIlliadGatewayStackProps) {
    super(scope, id, props)

    // LAMBDAS
    const paramStorePath = `/all/illiad-gateway/${props.stage}`
    const env = {
      SENTRY_DSN: StringParameter.valueForStringParameter(this, `${paramStorePath}/sentry_dsn`),
      SENTRY_ENVIRONMENT: props.stage,
      SENTRY_RELEASE: `${props.sentryProject}@${props.sentryVersion}`,
      ILLIAD_URL: StringParameter.valueForStringParameter(this, `${paramStorePath}/illiad_url`),
      API_KEY: SecretValue.secretsManager(props.secretsPath, { jsonField: 'api_key' }).toString(),
      AUTHORIZED_CLIENTS: StringParameter.valueForStringParameter(this, `${paramStorePath}/authorized_clients`),
    }

    const allLambda = new lambda.Function(this, 'AllFunction', {
      functionName: `${props.stackName}-all`,
      description: 'Get all non-cancelled requests for a user by netid.',
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'all.handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      logRetention: RetentionDays.ONE_WEEK,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: env,
    })

    const borrowedLambda = new lambda.Function(this, 'BorrowedFunction', {
      functionName: `${props.stackName}-borrowed`,
      description: 'Get both physical and digital items loaned to a user by netid.',
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'borrowed.handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      logRetention: RetentionDays.ONE_WEEK,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: env,
    })

    const checkedOutLambda = new lambda.Function(this, 'CheckedOutFunction', {
      functionName: `${props.stackName}-checkedOut`,
      description: 'Get physical items loaned to a user by netid.',
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'checkedOut.handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      logRetention: RetentionDays.ONE_WEEK,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: env,
    })

    const webLambda = new lambda.Function(this, 'WebFunction', {
      functionName: `${props.stackName}-web`,
      description: 'Get digital items loaned to a user by netid.',
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'web.handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      logRetention: RetentionDays.ONE_WEEK,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: env,
    })

    const pendingLambda = new lambda.Function(this, 'PendingFunction', {
      functionName: `${props.stackName}-pending`,
      description: 'Get pending request that have not been fulfilled or cancelled for a user by netid.',
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'pending.handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      logRetention: RetentionDays.ONE_WEEK,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: env,
    })

    // API GATEWAY
    const api = new apigateway.RestApi(this, 'ApiGateway', {
      restApiName: props.stackName,
      description: 'Illiad Gateway API',
      endpointExportName: `${props.stackName}-api-url`,
      deployOptions: {
        stageName: props.stage,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowCredentials: false,
        statusCode: 200,
      },
    })
    api.addRequestValidator('RequestValidator', {
      validateRequestParameters: true,
    })

    const authMethodOptions = {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: new apigateway.TokenAuthorizer(this, 'JwtAuthorizer', {
        handler: lambda.Function.fromFunctionArn(
          this,
          'AuthorizerFunction',
          `arn:aws:lambda:${this.region}:${this.account}:function:lambda-auth-${props.stage}`,
        ),
        identitySource: 'method.request.header.Authorization',
        authorizerName: 'jwt',
        resultsCacheTtl: cdk.Duration.minutes(5),
      }),
      requestParameters: {
        'method.request.header.Authorization': true,
      },
    }

    const endpointData = [
      { path: 'all', lambda: allLambda },
      { path: 'borrowed', lambda: borrowedLambda },
      { path: 'checkedOut', lambda: checkedOutLambda },
      { path: 'web', lambda: webLambda },
      { path: 'pending', lambda: pendingLambda },
    ]
    endpointData.forEach(endpoint => {
      const newResource = api.root.resourceForPath(endpoint.path)
      newResource.addMethod('GET', new apigateway.LambdaIntegration(endpoint.lambda), authMethodOptions)
    })

    // Mock endpoint for automated testing
    const testResource = api.root.addResource('test')
    const mockIntegrationOptions = {
      integrationResponses: [
        {
          statusCode: '200',
        },
      ],
      requestTemplates: {
        "application/json": `{ "statusCode": 200 }`
      }
    }
    testResource.addMethod('GET', new apigateway.MockIntegration(mockIntegrationOptions), {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            "application/json": new apigateway.EmptyModel(),
          },
        },
      ],
    })

    // Output API url to ssm so we can import it in the QA project
    new StringParameter(this, 'ApiUrlParameter', {
      parameterName: `${paramStorePath}/api-url`,
      description: 'Path to root of the API gateway.',
      stringValue: api.url,
    })
  }
}
