import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
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
    const bedrockModelIdCsv = this.node.tryGetContext("bedrockModelIdCsv") as string | undefined;
    const cognitoUserPoolId = this.node.tryGetContext("cognitoUserPoolId") as string | undefined;
    const cognitoClientId = this.node.tryGetContext("cognitoClientId") as string | undefined;
    const cognitoDomain = this.node.tryGetContext("cognitoDomain") as string | undefined;
    const opsAlertEmail = this.node.tryGetContext("opsAlertEmail") as string | undefined;

    const statementsKey = new kms.Key(this, "StatementsKey", {
      alias: `alias/finlens-${stage}-statements`,
      description: `SSE-KMS key for Finlens ${stage} statement objects`,
      enableKeyRotation: true,
      removalPolicy,
    });

    // S3 server access log target (ACLs required for the logging service principal).
    const statementsAccessLogsBucket = new s3.Bucket(this, "StatementsAccessLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy,
      autoDeleteObjects: stage !== "prod",
      lifecycleRules: [{ expiration: cdk.Duration.days(365) }],
    });

    const statementsBucket = new s3.Bucket(this, "StatementsBucket", {
      bucketName: undefined,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: statementsKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: stage !== "prod",
      serverAccessLogsBucket: statementsAccessLogsBucket,
      serverAccessLogsPrefix: "statements-access/",
      lifecycleRules: [
        {
          id: "ExpireStatementsAfter90Days",
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    const apiKeysTable = new dynamodb.Table(this, "ApiKeysTable", {
      partitionKey: { name: "keyHash", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
    });
    apiKeysTable.addGlobalSecondaryIndex({
      indexName: "byTenant",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "keyId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Single-table Workspace + membership (USER#sub / MEMBERSHIP, WORKSPACE#id / META).
    // TTL on expiresAt cleans daily quota counter rows (QUOTA#uploads|asks#YYYY-MM-DD); META/membership omit it.
    const workspacesTable = new dynamodb.Table(this, "WorkspacesTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
      timeToLiveAttribute: "expiresAt",
    });

    const statementsTable = new dynamodb.Table(this, "StatementsTable", {
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "statementId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
      timeToLiveAttribute: "expiresAt",
    });

    // Newest-first list without scanning UUID sort keys (#25). Partition stays tenantId
    // so Workspace isolation remains key-based (unlike the removed byStatementId GSI).
    statementsTable.addGlobalSecondaryIndex({
      indexName: "byTenantCreatedAt",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const repoRoot = path.join(__dirname, "../..");
    const cognitoEnv =
      cognitoUserPoolId && cognitoClientId
        ? {
            COGNITO_USER_POOL_ID: cognitoUserPoolId,
            COGNITO_CLIENT_ID: cognitoClientId,
            COGNITO_REGION: this.region,
            ...(cognitoDomain ? { COGNITO_DOMAIN: cognitoDomain } : {}),
          }
        : {};

    const lambdaEnv = {
      STATEMENTS_BUCKET: statementsBucket.bucketName,
      STATEMENTS_TABLE: statementsTable.tableName,
      API_KEYS_TABLE: apiKeysTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
      STAGE: stage,
      BEDROCK_MODEL_ID: bedrockModelId,
      ...(bedrockModelIdCsv ? { BEDROCK_MODEL_ID_CSV: bedrockModelIdCsv } : {}),
      ...(stage === "dev" && devApiKey ? { DEV_API_KEY: devApiKey } : {}),
      ...cognitoEnv,
    };

    const createStatementFn = new NodejsFunction(this, "CreateStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/create-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const getStatementFn = new NodejsFunction(this, "GetStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/get-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const listStatementsFn = new NodejsFunction(this, "ListStatementsFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/list-statements.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const deleteStatementFn = new NodejsFunction(this, "DeleteStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/delete-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const uploadStatementDirectFn = new NodejsFunction(this, "UploadStatementDirectFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/upload-statement-direct.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const apiKeysFn = new NodejsFunction(this, "ApiKeysFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/api-keys.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const mcpServerFn = new NodejsFunction(this, "McpServerFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/mcp-server.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      // Ask tool may call Bedrock; keep headroom beyond upload/get paths.
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const compareStatementsFn = new NodejsFunction(this, "CompareStatementsFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/compare-statements.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const getCategoryBreakdownFn = new NodejsFunction(this, "GetCategoryBreakdownFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/get-category-breakdown.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const askStatementFn = new NodejsFunction(this, "AskStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/ask-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
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
      logRetention: logs.RetentionDays.ONE_MONTH,
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
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthCallbackFn = new NodejsFunction(this, "OauthCallbackFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-proxy.ts"),
      handler: "callbackHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: oauthProxyEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const oauthTokenFn = new NodejsFunction(this, "OauthTokenFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/oauth-proxy.ts"),
      handler: "tokenHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: oauthProxyEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
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
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    const analyzeStatementFn = new NodejsFunction(this, "AnalyzeStatementFn", {
      entry: path.join(repoRoot, "apps/api/src/handlers/analyze-statement.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    statementsBucket.grantPut(createStatementFn);
    statementsBucket.grantPut(uploadStatementDirectFn);
    statementsBucket.grantRead(analyzeStatementFn);
    // Analyze may write oversized transaction extracts under the tenant prefix.
    statementsBucket.grantPut(analyzeStatementFn);
    statementsTable.grantReadWriteData(createStatementFn);
    statementsTable.grantReadWriteData(uploadStatementDirectFn);
    statementsTable.grantReadData(getStatementFn);
    // detail=full hydrates S3-backed extracts for REST get_statement.
    statementsBucket.grantRead(getStatementFn);
    statementsTable.grantReadData(listStatementsFn);
    statementsTable.grantReadWriteData(deleteStatementFn);
    statementsTable.grantReadWriteData(analyzeStatementFn);
    statementsTable.grantReadWriteData(mcpServerFn);
    statementsBucket.grantPut(mcpServerFn);
    statementsBucket.grantRead(mcpServerFn);
    statementsBucket.grantDelete(deleteStatementFn);
    statementsBucket.grantDelete(mcpServerFn);
    statementsTable.grantReadData(compareStatementsFn);
    statementsTable.grantReadData(getCategoryBreakdownFn);
    statementsTable.grantReadData(askStatementFn);
    statementsBucket.grantRead(compareStatementsFn);
    statementsBucket.grantRead(getCategoryBreakdownFn);
    statementsBucket.grantRead(askStatementFn);
    apiKeysTable.grantReadData(createStatementFn);
    apiKeysTable.grantReadData(getStatementFn);
    apiKeysTable.grantReadData(listStatementsFn);
    apiKeysTable.grantReadData(deleteStatementFn);
    apiKeysTable.grantReadData(uploadStatementDirectFn);
    apiKeysTable.grantReadData(mcpServerFn);
    apiKeysTable.grantReadData(compareStatementsFn);
    apiKeysTable.grantReadData(getCategoryBreakdownFn);
    apiKeysTable.grantReadData(askStatementFn);
    apiKeysTable.grantReadWriteData(apiKeysFn);
    workspacesTable.grantReadWriteData(createStatementFn);
    workspacesTable.grantReadWriteData(getStatementFn);
    workspacesTable.grantReadWriteData(listStatementsFn);
    workspacesTable.grantReadWriteData(deleteStatementFn);
    workspacesTable.grantReadWriteData(uploadStatementDirectFn);
    workspacesTable.grantReadWriteData(mcpServerFn);
    workspacesTable.grantReadWriteData(compareStatementsFn);
    workspacesTable.grantReadWriteData(getCategoryBreakdownFn);
    workspacesTable.grantReadWriteData(askStatementFn);
    workspacesTable.grantReadWriteData(apiKeysFn);

    const bedrockActions = ["bedrock:InvokeModel", "bedrock:Converse"] as const;
    const bedrockResources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:*:inference-profile/*",
    ];
    // Separate PolicyStatement instances — CDK forbids attaching one statement to multiple roles.
    for (const fn of [analyzeStatementFn, mcpServerFn, askStatementFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [...bedrockActions],
          resources: bedrockResources,
        }),
      );
    }

    const analyzeTask = new tasks.LambdaInvoke(this, "AnalyzeStatementTask", {
      lambdaFunction: analyzeStatementFn,
      payload: sfn.TaskInput.fromJsonPathAt("$"),
      outputPath: "$.Payload",
    });

    // LambdaInvoke already retries Lambda service errors (ServiceException, AWSLambdaException,
    // SdkClientException, ClientExecutionTimeoutException) by default; this adds Bedrock
    // transients surfaced through the Lambda, plus invoke throttling.
    analyzeTask.addRetry({
      errors: [
        "ThrottlingException",
        "ServiceUnavailableException",
        "InternalServerException",
        "ModelTimeoutException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });

    const markStatementFailed = new tasks.DynamoUpdateItem(this, "MarkStatementFailed", {
      table: statementsTable,
      key: {
        tenantId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt("$.tenantId")),
        statementId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt("$.statementId")),
      },
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, errorMessage = :errorMessage",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": tasks.DynamoAttributeValue.fromString("failed"),
        ":updatedAt": tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$$.State.EnteredTime"),
        ),
        ":errorMessage": tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.error.Cause"),
        ),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    const analysisFailed = new sfn.Fail(this, "AnalysisFailed", {
      error: "AnalysisFailed",
      cause: "AnalyzeStatement failed after retries; statement row marked as failed",
    });

    analyzeTask.addCatch(markStatementFailed.next(analysisFailed), {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const stateMachine = new sfn.StateMachine(this, "StatementPipeline", {
      stateMachineName: `finlens-${stage}-statement-pipeline`,
      definitionBody: sfn.DefinitionBody.fromChainable(analyzeTask),
      // Leaves headroom for up to 3 analyze attempts (5 min Lambda timeout each) plus backoff
      timeout: cdk.Duration.minutes(20),
    });

    // S3 invokes OnS3Upload async: after two failed retries the event is dropped,
    // so failures land here instead of silently stranding statements.
    const onS3UploadDlq = new sqs.Queue(this, "OnS3UploadDlq", {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
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
      onFailure: new destinations.SqsDestination(onS3UploadDlq),
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, target: "node20" },
    });

    statementsTable.grantReadWriteData(onS3UploadFn);
    stateMachine.grantStartExecution(onS3UploadFn);
    // Concurrent Analysis quota reads Statements (+ optional Workspace META limits).
    workspacesTable.grantReadData(onS3UploadFn);

    const opsAlertsTopic = new sns.Topic(this, "OpsAlertsTopic", {
      displayName: `finlens-${stage}-ops-alerts`,
      topicName: `finlens-${stage}-ops-alerts`,
    });
    if (opsAlertEmail) {
      opsAlertsTopic.addSubscription(new subscriptions.EmailSubscription(opsAlertEmail));
    }
    const snsAlarmAction = new cw_actions.SnsAction(opsAlertsTopic);

    const pipelineFailedAlarm = new cloudwatch.Alarm(this, "PipelineFailedAlarm", {
      alarmDescription: "Statement analysis executions are failing",
      metric: stateMachine.metricFailed({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    pipelineFailedAlarm.addAlarmAction(snsAlarmAction);

    const onS3UploadDlqAlarm = new cloudwatch.Alarm(this, "OnS3UploadDlqAlarm", {
      alarmDescription: "S3 upload events failed processing and landed in the DLQ",
      metric: onS3UploadDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    onS3UploadDlqAlarm.addAlarmAction(snsAlarmAction);

    statementsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(onS3UploadFn),
      { prefix: "statements/", suffix: ".pdf" },
    );
    statementsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(onS3UploadFn),
      { prefix: "statements/", suffix: ".csv" },
    );

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
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
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
        allowOrigins:
          stage === "prod" ? [`https://${webDistribution.distributionDomainName}`] : ["*"],
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
      path: "/v1/statements/compare",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "CompareStatementsIntegration",
        compareStatementsFn,
      ),
    });

    httpApi.addRoutes({
      path: "/v1/statements/{statementId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("GetStatementIntegration", getStatementFn),
    });

    httpApi.addRoutes({
      path: "/v1/statements/{statementId}/categories",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "GetCategoryBreakdownIntegration",
        getCategoryBreakdownFn,
      ),
    });

    httpApi.addRoutes({
      path: "/v1/statements/{statementId}/ask",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("AskStatementIntegration", askStatementFn),
    });

    httpApi.addRoutes({
      path: "/v1/statements/{statementId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new integrations.HttpLambdaIntegration(
        "DeleteStatementIntegration",
        deleteStatementFn,
      ),
    });

    httpApi.addRoutes({
      path: "/v1/api-keys",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("ApiKeysIntegration", apiKeysFn),
    });

    httpApi.addRoutes({
      path: "/v1/api-keys/{keyId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new integrations.HttpLambdaIntegration("ApiKeysDeleteIntegration", apiKeysFn),
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
    new cdk.CfnOutput(this, "StatementsKeyArn", { value: statementsKey.keyArn });
    new cdk.CfnOutput(this, "StatementsAccessLogsBucketName", {
      value: statementsAccessLogsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "ApiKeysTableName", { value: apiKeysTable.tableName });
    new cdk.CfnOutput(this, "WorkspacesTableName", { value: workspacesTable.tableName });
    new cdk.CfnOutput(this, "StatementsTableName", { value: statementsTable.tableName });
    if (cognitoUserPoolId) {
      new cdk.CfnOutput(this, "CognitoUserPoolId", { value: cognitoUserPoolId });
    }
    if (cognitoClientId) {
      new cdk.CfnOutput(this, "CognitoClientId", { value: cognitoClientId });
    }
    if (cognitoDomain) {
      new cdk.CfnOutput(this, "CognitoDomain", { value: cognitoDomain });
    }
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "WebUrl", { value: `https://${webDistribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "McpUrl", { value: `${httpApi.apiEndpoint}/mcp` });
    new cdk.CfnOutput(this, "BedrockModelId", { value: bedrockModelId });
    new cdk.CfnOutput(this, "StatementPipelineArn", { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, "OpsAlertsTopicArn", { value: opsAlertsTopic.topicArn });
    if (stage === "dev" && devApiKey) {
      new cdk.CfnOutput(this, "DevApiKey", { value: devApiKey });
    }
  }
}
