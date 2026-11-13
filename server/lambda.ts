/**
 * AWS entry point: one Lambda function behind an API Gateway HTTP API.
 * API Gateway has already checked the caller's Cognito token before this runs.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleRequest } from './core/router.ts';
import { DynamoStore } from './stores/dynamoStore.ts';

const store = new DynamoStore(process.env.TABLE_NAME ?? '');
const secrets = new SecretsManagerClient({});

// The key is read from Secrets Manager on first use and kept for the life of
// this function instance. It is never logged or returned to the browser.
let apiKey: Promise<string> | null = null;
function getApiKey(): Promise<string> {
  apiKey ??= secrets
    .send(new GetSecretValueCommand({ SecretId: process.env.CLAUDE_KEY_SECRET ?? '' }))
    .then((result) => (result.SecretString ?? '').trim())
    .catch((err) => {
      apiKey = null; // try again on the next request
      console.error('Could not read the Claude API key secret', (err as Error).name);
      return '';
    });
  return apiKey;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof userId !== 'string' || !userId) {
    return { statusCode: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"Sign in first."}' };
  }

  const body =
    event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? null);

  const response = await handleRequest(
    {
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: new URLSearchParams(event.rawQueryString),
      body,
      userId,
    },
    { store, getApiKey },
  );

  if (typeof response.body === 'string') {
    return { statusCode: response.status, headers: response.headers, body: response.body };
  }
  return {
    statusCode: response.status,
    headers: response.headers,
    body: Buffer.from(response.body).toString('base64'),
    isBase64Encoded: true,
  };
}
