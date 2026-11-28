import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ADMIN_GROUP, APPS, appGroup, SELF_APP_ID } from '../../shared/apps.js';
import { ACCESS_LOG_PREFIX, EVENTS_LOG_GROUP, EVENTS_URL_PARAM } from '../../shared/logs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_DEV_URL = 'http://localhost:5173';
/** 他のアプリが共通ログインの設定を読むための SSM パラメータの置き場所 */
export const AUTH_PARAM_PREFIX = '/wakalabo/auth';

/**
 * API Gateway のアクセスログの形 (1 リクエスト 1 行の JSON)。各アプリの CDK にも同じものを書く。
 * URL のパスやクエリ (ショートカットのトークンや明細の ID が入る) と本文は残さない。ルートの名前 (routeKey) だけを残す
 */
export const ACCESS_LOG_FORMAT = JSON.stringify({
  t: '$context.requestTimeEpoch',
  id: '$context.requestId',
  route: '$context.routeKey',
  status: '$context.status',
  latency: '$context.responseLatency',
  ilatency: '$context.integrationLatency',
  sub: '$context.authorizer.claims.sub',
  ip: '$context.identity.sourceIp',
  ua: '$context.identity.userAgent',
  err: '$context.error.message',
  ierr: '$context.integrationErrorMessage',
})
  // 数値は数値として残す (Logs Insights で平均などを出すため)。どちらも必ず値が入る
  .replace('"$context.status"', '$context.status')
  .replace('"$context.responseLatency"', '$context.responseLatency');

export interface AppsStackProps extends cdk.StackProps {
  /** 独自ドメイン (apps.wakalabo.net)。certificateArn (us-east-1 の ACM) とセットで指定 */
  domainName?: string;
  certificateArn?: string;
}

export class AppsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppsStackProps = {}) {
    super(scope, id, props);

    if (!!props.domainName !== !!props.certificateArn) throw new Error('domainName と certificateArn は両方指定してください');
    if (props.certificateArn && !props.certificateArn.startsWith('arn:aws:acm:us-east-1:')) {
      throw new Error('CloudFront で使う証明書は us-east-1 で作成したものを指定してください');
    }

    // ---------- 画面 (S3 + CloudFront) ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html' })),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      ...(props.domainName &&
        props.certificateArn && {
          domainNames: [props.domainName],
          certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn),
        }),
    });
    const cloudfrontUrl = `https://${distribution.distributionDomainName}`;
    const siteUrls = props.domainName ? [`https://${props.domainName}`, cloudfrontUrl] : [cloudfrontUrl];

    // ---------- 共通ログイン (Cognito) ----------
    // パスキーのドメイン: apps.wakalabo.net → wakalabo.net (独自ドメインがないときはパスキーを使わない)
    const passkeyRpId = props.domainName?.split('.').slice(1).join('.');
    // すべてのアプリで使うユーザープール。ここでユーザーを作り、使えるアプリをグループで決める
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'wakalabo-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // パスキー (WebAuthn) でもログインできるようにする。パスキーは Essentials プランの機能 (月 10,000 人まで無料)。
      // 以下はどれもユーザープールを作り直さずに変更できる設定 (作り直すとユーザーが消えるので、名前などは変えない)
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: !!passkeyRpId } },
      // パスキーを結び付けるドメイン。W-SSO の画面 (apps.wakalabo.net) から使うので、その親の wakalabo.net にする
      ...(passkeyRpId && { passkeyRelyingPartyId: passkeyRpId }),
      // Face ID / Touch ID / PIN などの本人確認ができるパスキーだけ受け付ける (パスキーだけでログインできるため)
      passkeyUserVerification: cognito.PasskeyUserVerification.REQUIRED,
    });
    const domain = userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: `wakalabo-${this.account}` } });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: 'ダッシュボードの管理 (ユーザー管理・利用料の表示)。すべてのアプリを使える',
    });

    const oauthClient = (cid: string, urls: string[]) =>
      userPool.addClient(cid, {
        generateSecret: false,
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
          callbackUrls: urls.map((u) => `${u}/`),
          logoutUrls: urls.map((u) => `${u}/`),
        },
        preventUserExistenceErrors: true,
        accessTokenValidity: cdk.Duration.hours(1),
        idTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.days(30),
      });

    // ダッシュボード自身 (Cognito のログイン画面を使っていたころのもの。W-SSO に移ったので使っていない)
    const portalClient = oauthClient('PortalClient', [...siteUrls, LOCAL_DEV_URL]);

    // ---------- W-SSO (自作のログイン画面 /sso.html で使う、全アプリ共通のクライアント) ----------
    // パスワードは画面から Cognito に直接送る (USER_PASSWORD_AUTH、通信は HTTPS)。
    // 各アプリの API は、このクライアントのアクセストークンを受け付け、グループ (admin / app-<id>) で使えるか判断する
    const wssoClient = userPool.addClient('WssoClient', {
      generateSecret: false,
      // userPassword: パスワードでログイン (USER_PASSWORD_AUTH)、user: パスキーでログイン (USER_AUTH)
      authFlows: { userPassword: true, user: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });
    new ssm.StringParameter(this, 'WssoClientParam', {
      parameterName: `${AUTH_PARAM_PREFIX}/wsso-client-id`,
      stringValue: wssoClient.userPoolClientId,
      description: 'W-SSO の共通クライアント ID',
    });
    new ssm.StringParameter(this, 'SsoUrlParam', {
      parameterName: `${AUTH_PARAM_PREFIX}/sso-url`,
      stringValue: siteUrls[0]!,
      description: 'W-SSO のログイン画面がある URL',
    });
    // W-SSO がログイン後に戻ってよいアプリ (これ以外には戻さない)
    const allowedOrigins = [...new Set([...siteUrls, ...APPS.map((a) => new URL(a.url).origin), LOCAL_DEV_URL])];

    // 各アプリ用。グループ (app-<id>) と、アプリ側の CDK が読むための SSM パラメータも作る。
    // 同じユーザープールなので、どれか 1 つでログインすれば、他のアプリもログイン画面を通るだけで入れる
    for (const app of APPS) {
      const cid = app.id.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
      new cognito.CfnUserPoolGroup(this, `Group${cid}`, {
        userPoolId: userPool.userPoolId,
        groupName: appGroup(app.id),
        description: `${app.name} を使えるユーザー`,
      });
      const client = oauthClient(`Client${cid}`, [app.url, LOCAL_DEV_URL]);
      new ssm.StringParameter(this, `ClientParam${cid}`, {
        parameterName: `${AUTH_PARAM_PREFIX}/clients/${app.id}`,
        stringValue: client.userPoolClientId,
        description: `${app.name} の共通ログイン用クライアント ID`,
      });
    }
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `${AUTH_PARAM_PREFIX}/user-pool-id`,
      stringValue: userPool.userPoolId,
    });
    new ssm.StringParameter(this, 'DomainParam', {
      parameterName: `${AUTH_PARAM_PREFIX}/domain`,
      stringValue: domain.baseUrl(),
    });

    // ---------- API (API Gateway + Lambda) ----------
    const costCache = new ssm.StringParameter(this, 'CostCache', {
      parameterName: '/wakalabo-apps/cache/costs',
      stringValue: '{}',
      description: 'Lambda が書き込む利用料のキャッシュ (手で編集しない)',
    });

    const fn = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(root, 'api/src/handler.ts'),
      projectRoot: root,
      depsLockFilePath: path.join(root, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // ログの検索 (Logs Insights) を待つので長め (API Gateway の上限 30 秒より短く)
      timeout: cdk.Duration.seconds(28),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        COST_CACHE_PARAM: costCache.parameterName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    costCache.grantRead(fn);
    costCache.grantWrite(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:ListUsers',
          'cognito-idp:ListUsersInGroup',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    // Cost Explorer / Free Tier の読み取りはリソース単位の指定ができないので * になる (読み取りのみ)
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ce:GetCostAndUsage', 'freetier:GetAccountPlanState'], resources: ['*'] }),
    );

    const authorizer = new HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [portalClient.userPoolClientId, wssoClient.userPoolClientId] },
    );
    const api = new apigw.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        // 各アプリの画面からも、ログ (POST /events) を送れるようにする。管理用の API は管理者のトークンがないと使えない
        allowOrigins: allowedOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    const { GET, POST, PUT, DELETE } = apigw.HttpMethod;
    api.addRoutes({ path: '/apps', methods: [GET], integration });
    api.addRoutes({ path: '/costs', methods: [GET], integration });
    api.addRoutes({ path: '/admin/users', methods: [GET, POST], integration });
    api.addRoutes({ path: '/admin/users/{username}', methods: [PUT, DELETE], integration });
    api.addRoutes({ path: '/admin/logs', methods: [GET], integration });
    const stage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    // ---------- ログ ----------
    // 1. このダッシュボードの API のアクセスログ (各アプリも /wakalabo/access/<アプリ> に同じ形で残す)
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: `${ACCESS_LOG_PREFIX}${SELF_APP_ID}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    stage.accessLogSettings = { destinationArn: accessLogs.logGroupArn, format: ACCESS_LOG_FORMAT };

    // 2. 各アプリの画面から届くログ (開いた画面・画面のエラー・表示にかかった時間)。
    //    受け取る Lambda のログそのものを使う。JSON 形式にして、START / END などの行は出さない
    const eventsFn = new nodejs.NodejsFunction(this, 'EventsFunction', {
      entry: path.join(root, 'api/src/events.ts'),
      projectRoot: root,
      depsLockFilePath: path.join(root, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      bundling: { minify: true, externalModules: [] },
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      logGroup: new logs.LogGroup(this, 'EventsLogs', {
        logGroupName: EVENTS_LOG_GROUP,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    api.addRoutes({ path: '/events', methods: [POST], integration: new HttpLambdaIntegration('EventsIntegration', eventsFn) });
    new ssm.StringParameter(this, 'EventsUrlParam', {
      parameterName: EVENTS_URL_PARAM,
      stringValue: `${api.apiEndpoint}/events`,
      description: '各アプリの画面がログを送る先 (wakalabo-apps の POST /events)',
    });

    // 3. 管理画面の「ログ」: Logs Insights で /wakalabo/ のロググループを検索する
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:StartQuery'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/wakalabo/*`],
      }),
    );
    // 検索結果の取得とロググループの一覧は、リソース単位の指定ができないので * になる (読み取りのみ)
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:GetQueryResults', 'logs:DescribeLogGroups'], resources: ['*'] }));

    // ---------- 画面のデプロイ ----------
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(path.join(root, 'web/dist')),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.apiEndpoint,
          wssoClientId: wssoClient.userPoolClientId,
          allowedOrigins,
          region: this.region,
          account: this.account,
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrls[0]! });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() });
  }
}
