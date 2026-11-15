import * as cdk from 'aws-cdk-lib';
import { SELF_APP_ID } from '../../shared/apps.js';
import { AppsStack } from '../lib/apps-stack.js';

const app = new cdk.App();

// ダッシュボード・共通ログイン。CloudShell からデプロイする (README 参照)
const stack = new AppsStack(app, 'WakalaboApps', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
  // 独自ドメインと、その証明書 (us-east-1 の ACM)。cdk.json の context に書く
  domainName: app.node.tryGetContext('domainName') || undefined,
  certificateArn: app.node.tryGetContext('certificateArn') || undefined,
});

// アプリごとの利用料を出すための目印
cdk.Tags.of(stack).add('app', SELF_APP_ID);
