import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

export interface FinlensStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
}

export class FinlensStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FinlensStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const removalPolicy = stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const devApiKey = this.node.tryGetContext("devApiKey") as string;
    const bedrockModelId = this.node.tryGetContext("bedrockModelId") as string;
    const cognitoUserPoolId = this.node.tryGetContext("cognitoUserPoolId") as string | undefined;
    const cognitoClientId = this.node.tryGetContext("cognitoClientId") as string | undefined;
    const cognitoDomain = this.node.tryGetContext("cognitoDomain") as string | undefined;

    const statementsBucket = new s3.Bucket(this, "StatementsBucket", {
      bucketName: undefined,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: stage !== "prod",
    });

    const apiKeysTable = new dynamodb.Table(this, "ApiKeysTable", {
      partitionKey: { name: "keyHash", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    const statementsTable = new dynamodb.Table(this, "StatementsTable", {
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "statementId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    statementsTable.addGlobalSecondaryIndex({
      indexName: "byStatementId",
      partitionKey: { name: "statementId", type: dynamodb.AttributeType.STRING },
    });

    const repoRoot = path.join(__dirname, "../..");
    const lambdaEnv = {
      STATEMENTS_BUCKET: statementsBucket.bucketName,
      STATEMENTS_TABLE: statementsTable.tableName,
      STAGE: stage,
      BEDROCK_MODEL_ID: bedrockModelId,
      ...(stage === "dev" && devApiKey ? { DEV_API_KEY: devApiKey } : {}),
    };

    const createStatementFn = new NodejsFunction(this, "CreateStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/create-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const getStatementFn = new NodejsFunction(this, "GetStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/get-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const listStatementsFn = new NodejsFunction(this, "ListStatementsFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/list-statements.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const uploadStatementDirectFn = new NodejsFunction(this, "UploadStatementDirectFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/upload-statement-direct.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: lambdaEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const cognitoEnv =
      cognitoUserPoolId && cognitoClientId
        ? {
            COGNITO_USER_POOL_ID: cognitoUserPoolId,
            COGNITO_CLIENT_ID: cognitoClientId,
            COGNITO_REGION: this.region,
            ...(cognitoDomain ? { COGNITO_DOMAIN: cognitoDomain } : {}),
          }
        : {};

    const mcpServerFn = new NodejsFunction(this, "McpServerFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/mcp-server.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...lambdaEnv,
        ...cognitoEnv,
      },
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthMetadataFn = new NodejsFunction(this, "OauthMetadataFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-metadata.ts"),
      handler: "protectedResourceHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      environment: {
        STAGE: stage,
        ...cognitoEnv,
      },
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthProxyEnv = {
      STAGE: stage,
      ...cognitoEnv,
    };

    const oauthProxyFn = new NodejsFunction(this, "OauthProxyFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-proxy.ts"),
      handler: "authorizeHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: oauthProxyEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthCallbackFn = new NodejsFunction(this, "OauthCallbackFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-proxy.ts"),
      handler: "callbackHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: oauthProxyEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthTokenFn = new NodejsFunction(this, "OauthTokenFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-proxy.ts"),
      handler: "tokenHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: oauthProxyEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthAuthServerFn = new NodejsFunction(this, "OauthAuthServerFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-metadata.ts"),
      handler: "authorizationServerHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      environment: {
        STAGE: stage,
        ...cognitoEnv,
      },
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const analyzeStatementFn = new NodejsFunction(this, "AnalyzeStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/analyze-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: lambdaEnv,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    statementsBucket.grantPut(createStatementFn);
    statementsBucket.grantPut(uploadStatementDirectFn);
    statementsBucket.grantRead(analyzeStatementFn);
    statementsTable.grantReadWriteData(createStatementFn);
    statementsTable.grantReadWriteData(uploadStatementDirectFn);
    statementsTable.grantReadData(getStatementFn);
    statementsTable.grantReadData(listStatementsFn);
    statementsTable.grantReadWriteData(analyzeStatementFn);
    statementsTable.grantReadWriteData(mcpServerFn);
    statementsBucket.grantPut(mcpServerFn);

    analyzeStatementFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:Converse"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:*:*:inference-profile/*",
        ],
      }),
    );

    const analyzeTask = new tasks.LambdaInvoke(this, "AnalyzeStatementTask", {
      lambdaFunction: analyzeStatementFn,
      payload: sfn.TaskInput.fromJsonPathAt("$"),
      outputPath: "$.Payload",
    });

    const stateMachine = new sfn.StateMachine(this, "StatementPipeline", {
      stateMachineName: `finlens-${stage}-statement-pipeline`,
      definitionBody: sfn.DefinitionBody.fromChainable(analyzeTask),
      timeout: cdk.Duration.minutes(10),
    });

    const onS3UploadFn = new NodejsFunction(this, "OnS3UploadFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/on-s3-upload.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...lambdaEnv,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    statementsTable.grantReadWriteData(onS3UploadFn);
    stateMachine.grantStartExecution(onS3UploadFn);

    statementsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(onS3UploadFn),
      { prefix: "statements/", suffix: ".pdf" },
    );

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `finlens-${stage}`,
      corsPreflight: {
        allowHeaders: [
          "content-type",
          "x-api-key",
          "authorization",
          "accept",
          "mcp-session-id",
          "mcp-protocol-version",
          "last-event-id",
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ["*"],
      },
    });

    httpApi.addRoutes({
      path: "/v1/statements",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("CreateStatementIntegration", createStatementFn),
    });

    httpApi.addRoutes({
      path: "/v1/statements",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("ListStatementsIntegration", listStatementsFn),
    });

    httpApi.addRoutes({
      path: "/v1/statements/upload",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("UploadStatementDirectIntegration", uploadStatementDirectFn),
    });

    httpApi.addRoutes({
      path: "/v1/statements/{statementId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("GetStatementIntegration", getStatementFn),
    });

    httpApi.addRoutes({
      path: "/mcp",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: new integrations.HttpLambdaIntegration("McpServerIntegration", mcpServerFn),
    });

    httpApi.addRoutes({
      path: "/oauth/authorize",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("OauthAuthorizeIntegration", oauthProxyFn),
    });

    httpApi.addRoutes({
      path: "/oauth/callback",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("OauthCallbackIntegration", oauthCallbackFn),
    });

    httpApi.addRoutes({
      path: "/oauth/token",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("OauthTokenIntegration", oauthTokenFn),
    });

    httpApi.addRoutes({
      path: "/.well-known/oauth-protected-resource",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "OauthProtectedResourceIntegration",
        oauthMetadataFn,
      ),
    });

    httpApi.addRoutes({
      path: "/.well-known/oauth-authorization-server",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "OauthAuthorizationServerIntegration",
        oauthAuthServerFn,
      ),
    });

    mcpServerFn.addEnvironment("API_PUBLIC_URL", httpApi.apiEndpoint);
    oauthMetadataFn.addEnvironment("API_PUBLIC_URL", httpApi.apiEndpoint);
    oauthAuthServerFn.addEnvironment("API_PUBLIC_URL", httpApi.apiEndpoint);
    oauthProxyFn.addEnvironment("API_PUBLIC_URL", httpApi.apiEndpoint);
    oauthCallbackFn.addEnvironment("API_PUBLIC_URL", httpApi.apiEndpoint);
    oauthTokenFn.addEnvironment("API_PUBLIC_URL", httpApi.apiEndpoint);

    const webBucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: stage !== "prod",
    });

    const webDistribution = new cloudfront.Distribution(this, "WebDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    const webOutDir = path.join(repoRoot, "apps/web/out");
    if (fs.existsSync(webOutDir)) {
      new s3deploy.BucketDeployment(this, "WebDeploy", {
        sources: [s3deploy.Source.asset(webOutDir)],
        destinationBucket: webBucket,
        distribution: webDistribution,
        distributionPaths: ["/*"],
      });
    }

    new cdk.CfnOutput(this, "Stage", { value: stage });
    new cdk.CfnOutput(this, "StatementsBucketName", { value: statementsBucket.bucketName });
    new cdk.CfnOutput(this, "ApiKeysTableName", { value: apiKeysTable.tableName });
    new cdk.CfnOutput(this, "StatementsTableName", { value: statementsTable.tableName });
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "WebUrl", { value: `https://${webDistribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "McpUrl", { value: `${httpApi.apiEndpoint}/mcp` });
    new cdk.CfnOutput(this, "BedrockModelId", { value: bedrockModelId });
    new cdk.CfnOutput(this, "StatementPipelineArn", { value: stateMachine.stateMachineArn });
    if (stage === "dev" && devApiKey) {
      new cdk.CfnOutput(this, "DevApiKey", { value: devApiKey });
    }
  }
}
