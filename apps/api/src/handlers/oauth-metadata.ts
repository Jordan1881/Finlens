import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { cognitoIssuer } from "../lib/cognito-auth";
import { json } from "../lib/http";

export async function protectedResourceHandler(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const issuer = cognitoIssuer();
  const domain = process.env.COGNITO_DOMAIN;
  const apiUrl = process.env.API_PUBLIC_URL;

  if (!issuer || !domain || !apiUrl) {
    return json(500, { error: "OAuth metadata is not configured" });
  }

  const resource = `${apiUrl}/mcp`;

  return json(200, {
    resource,
    authorization_servers: [apiUrl],
    scopes_supported: ["openid", "email"],
    bearer_methods_supported: ["header"],
  });
}

export async function authorizationServerHandler(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const issuer = cognitoIssuer();
  const domain = process.env.COGNITO_DOMAIN;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const apiUrl = process.env.API_PUBLIC_URL;

  if (!issuer || !domain || !clientId || !apiUrl) {
    return json(500, { error: "OAuth metadata is not configured" });
  }

  return json(200, {
    issuer: apiUrl,
    authorization_endpoint: `${apiUrl}/oauth/authorize`,
    token_endpoint: `${apiUrl}/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email"],
  });
}
