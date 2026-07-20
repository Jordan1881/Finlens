import { CognitoJwtVerifier } from "aws-jwt-verify";

let accessVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getAccessVerifier() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) {
    throw new Error("Cognito is not configured");
  }

  if (!accessVerifier) {
    accessVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: "access",
      clientId,
    });
  }

  return accessVerifier;
}

export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const payload = await getAccessVerifier().verify(token);
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function getBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function cognitoIssuer(): string | null {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const region = process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "eu-west-1";
  if (!userPoolId) {
    return null;
  }
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}
