import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface FinlensStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
}

export class FinlensStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FinlensStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const removalPolicy = stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

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

    new cdk.CfnOutput(this, "Stage", { value: stage });
    new cdk.CfnOutput(this, "StatementsBucketName", { value: statementsBucket.bucketName });
    new cdk.CfnOutput(this, "ApiKeysTableName", { value: apiKeysTable.tableName });
    new cdk.CfnOutput(this, "StatementsTableName", { value: statementsTable.tableName });
  }
}
