import { CognitoJwtVerifier } from "aws-jwt-verify";

let accessVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let idVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifiers() {
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

  if (!idVerifier) {
    idVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: "id",
      clientId,
    });
  }

  return { accessVerifier, idVerifier };
}

export async function verifyAccessToken(token: string): Promise<string | null> {
  const { accessVerifier: access, idVerifier: id } = getVerifiers();

  for (const verifier of [access, id]) {
    try {
      const payload = await verifier.verify(token);
      if (typeof payload.sub === "string") {
        return payload.sub;
      }
    } catch {
      // try next token type
    }
  }

  return null;
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
