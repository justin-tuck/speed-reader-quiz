import * as cdk from 'aws-cdk-lib';
import { SpeedReaderQuizStack } from '../lib/stack.ts';

const app = new cdk.App();

new SpeedReaderQuizStack(app, 'SpeedReaderQuiz', {
  description: 'Speed Reader Quiz - site, API, login and database',
  // Uses the account and region of the AWS profile you deploy with.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  // Guards the database and user accounts against an accidental stack deletion.
  terminationProtection: true,
});
