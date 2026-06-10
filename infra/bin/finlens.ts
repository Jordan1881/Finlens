#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { FinlensStack } from "../lib/finlens-stack";

const app = new cdk.App();

const account = app.node.tryGetContext("account") as string;
const region = app.node.tryGetContext("region") as string;

const env: cdk.Environment = { account, region };

new FinlensStack(app, "FinlensDevStack", {
  env,
  stage: "dev",
});

new FinlensStack(app, "FinlensProdStack", {
  env,
  stage: "prod",
});
