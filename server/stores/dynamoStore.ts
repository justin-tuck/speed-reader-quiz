import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SyncRecord, SyncStore } from '../../shared/api.ts';
import type { RecordStore } from '../core/sync.ts';

/** Name of the local secondary index that orders a user's records by write time. */
export const VERSION_INDEX = 'byVersion';

/**
 * One table for everything. Each user's records share a partition:
 *   pk = USER#<user id>, sk = <store>#<record id>
 * The `version` attribute (server write time) is the sort key of a local
 * secondary index, which answers "what changed since my last sync?".
 */
export class DynamoStore implements RecordStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(table: string, client = new DynamoDBClient({})) {
    this.table = table;
    this.client = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async putIfNewer(userId: string, record: SyncRecord, version: number): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: `USER#${userId}`,
            sk: `${record.store}#${record.id}`,
            store: record.store,
            id: record.id,
            updatedAt: record.updatedAt,
            deleted: record.deleted === true ? true : undefined,
            data: record.deleted ? undefined : record.data,
            version,
          },
          // Newest change wins: never overwrite a record that was changed later.
          ConditionExpression: 'attribute_not_exists(pk) OR updatedAt < :updatedAt',
          ExpressionAttributeValues: { ':updatedAt': record.updatedAt },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async listSince(userId: string, sinceVersion: number, limit: number, pageToken?: string) {
    let startKey: Record<string, unknown> | undefined;
    if (pageToken) {
      try {
        startKey = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as Record<string, unknown>;
        // A page token may only continue the caller's own partition.
        if (startKey.pk !== `USER#${userId}`) startKey = undefined;
      } catch {
        startKey = undefined;
      }
    }
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: VERSION_INDEX,
        KeyConditionExpression: 'pk = :pk AND #version > :since',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':since': sinceVersion },
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    const records: SyncRecord[] = (result.Items ?? []).map((item) => ({
      store: item.store as SyncStore,
      id: item.id as string,
      updatedAt: item.updatedAt as number,
      ...(item.deleted ? { deleted: true } : { data: item.data as unknown }),
    }));
    const nextPageToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
      : undefined;
    return { records, nextPageToken };
  }
}
