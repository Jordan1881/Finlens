#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { FinlensStack } from "../lib/finlens-stack";

const app = new cdk.App();

const region = app.node.tryGetContext("region") as string;

new FinlensStack(app, "FinlensDevStack", {
  env: { region },
  stage: "dev",
});

new FinlensStack(app, "FinlensProdStack", {
  env: { region },
  stage: "prod",
});
