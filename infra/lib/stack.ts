import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { AppConfig } from '../../shared/api.ts';
import { siteContentSecurityPolicy } from '../../server/securityHeaders.ts';
import { VERSION_INDEX } from '../../server/stores/dynamoStore.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Name of the Secrets Manager secret that holds the Claude API key. You
 * create it yourself before deploying (see the README), so the key never
 * passes through this code or CloudFormation.
 */
export const CLAUDE_KEY_SECRET_NAME = 'speed-reader-quiz/anthropic-api-key';

export class SpeedReaderQuizStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Database: all synced records, one partition per user.
    const table = new dynamodb.Table(this, 'Records', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    table.addLocalSecondaryIndex({
      indexName: VERSION_INDEX,
      sortKey: { name: 'version', type: dynamodb.AttributeType.NUMBER },
    });

    // --- Login: accounts are created by you, not by visitors.
    const userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const loginDomain = userPool.addDomain('LoginDomain', {
      cognitoDomain: { domainPrefix: `speed-reader-quiz-${this.account}` },
    });

    // --- Backend function.
    const claudeKey = secretsmanager.Secret.fromSecretNameV2(this, 'ClaudeKey', CLAUDE_KEY_SECRET_NAME);
    const backend = new NodejsFunction(this, 'Backend', {
      entry: path.join(root, 'server', 'lambda.ts'),
      handler: 'handler',
      projectRoot: root,
      depsLockFilePath: path.join(root, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // API Gateway stops waiting after 30 seconds.
      timeout: cdk.Duration.seconds(29),
      environment: {
        TABLE_NAME: table.tableName,
        CLAUDE_KEY_SECRET: CLAUDE_KEY_SECRET_NAME,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
      logGroup: new logs.LogGroup(this, 'BackendLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(backend);
    claudeKey.grantRead(backend);

    // --- API: every route requires a valid sign-in token.
    const api = new apigw.HttpApi(this, 'Api', { createDefaultStage: false });
    new apigw.HttpStage(this, 'ApiStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      // A ceiling on request volume, which also caps Claude spend.
      throttle: { rateLimit: 10, burstLimit: 20 },
    });

    // --- Site: private bucket served through CloudFront, with /api/* passed to the API.
    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The site can always be rebuilt from this repository.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const authority = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    const loginUrl = loginDomain.baseUrl();
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: siteContentSecurityPolicy([
            `https://cognito-idp.${this.region}.amazonaws.com`,
            loginUrl,
          ]),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Speed Reader Quiz',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Passes the Authorization header and query string through to the API.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;

    // Browser app client: no secret, authorization code flow with PKCE.
    const webClient = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${siteUrl}/`],
        logoutUrls: [`${siteUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    api.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('BackendIntegration', backend),
      authorizer: new HttpUserPoolAuthorizer('SignedIn', userPool, { userPoolClients: [webClient] }),
    });

    // The built app, plus the config file that tells it how to sign in.
    const config: AppConfig = { auth: { authority, clientId: webClient.userPoolClientId, domain: loginUrl } };
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(root, 'dist')), s3deploy.Source.jsonData('config.json', config)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      // Browsers re-check files on each visit, so a new deploy shows up at once.
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl, description: 'Open this to use the app' });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId, description: 'Needed to create your account' });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
