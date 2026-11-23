// トークン使用量の DynamoDB (オンデマンド課金)。
//  - 使用量:   pk=U#<ユーザー名>  sk=D#<日付>#<source>#<モデル>   i/o/cr/cw/n に足し込む (1 日・1 発生元・1 モデルで 1 行)
//  - 送信キー: pk=KEY             sk=<キーの SHA-256>              ユーザー名・ラベル・種類・作成日時
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { usagePk, usageSk, type UsageEntry, type UsageRow } from './usage-core.js';

const TABLE = process.env.USAGE_TABLE ?? '';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface StoredKey {
  id: string;
  scope: 'user' | 'service';
  username?: string;
  label: string;
  createdAt: string;
}

/** 明細を、その日の行に足し込む (同じキーに何度送っても、送った分だけ増える) */
export async function recordUsage(username: string, date: string, entries: UsageEntry[]): Promise<void> {
  await Promise.all(
    entries.map((e) =>
      db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: usagePk(username), sk: usageSk(date, e.source, e.model) },
          UpdateExpression: 'ADD #i :i, #o :o, #cr :cr, #cw :cw, #n :n SET updatedAt = :now',
          ExpressionAttributeNames: { '#i': 'i', '#o': 'o', '#cr': 'cr', '#cw': 'cw', '#n': 'n' },
          ExpressionAttributeValues: { ':i': e.input, ':o': e.output, ':cr': e.cacheRead, ':cw': e.cacheWrite, ':n': e.requests, ':now': new Date().toISOString() },
        }),
      ),
    ),
  );
}

/** 月の明細をすべて読む。件数は「日数 × ユーザー × 発生元 × モデル」程度なので、Scan で足りる */
export async function readMonth(month: string): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'begins_with(pk, :u) AND begins_with(sk, :m)',
        ExpressionAttributeValues: { ':u': 'U#', ':m': `D#${month}-` },
        ExclusiveStartKey: start,
      }),
    );
    for (const it of res.Items ?? []) {
      rows.push({
        pk: String(it.pk),
        sk: String(it.sk),
        input: Number(it.i ?? 0),
        output: Number(it.o ?? 0),
        cacheRead: Number(it.cr ?? 0),
        cacheWrite: Number(it.cw ?? 0),
        requests: Number(it.n ?? 0),
      });
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return rows;
}

export async function findKey(id: string): Promise<StoredKey | undefined> {
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'KEY', sk: id } }));
  return res.Item ? toKey(res.Item) : undefined;
}

export async function listKeys(): Promise<StoredKey[]> {
  const res = await db.send(
    new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :k', ExpressionAttributeValues: { ':k': 'KEY' } }),
  );
  return (res.Items ?? []).map(toKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putKey(k: StoredKey): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: { pk: 'KEY', sk: k.id, scope: k.scope, username: k.username, label: k.label, createdAt: k.createdAt },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

/** 消せたら true、もともと無ければ false */
export async function deleteKey(id: string): Promise<boolean> {
  try {
    await db.send(
      new DeleteCommand({ TableName: TABLE, Key: { pk: 'KEY', sk: id }, ConditionExpression: 'attribute_exists(pk)' }),
    );
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return false;
    throw e;
  }
}

function toKey(it: Record<string, unknown>): StoredKey {
  return {
    id: String(it.sk),
    scope: it.scope === 'service' ? 'service' : 'user',
    username: typeof it.username === 'string' ? it.username : undefined,
    label: String(it.label ?? ''),
    createdAt: String(it.createdAt ?? ''),
  };
}
