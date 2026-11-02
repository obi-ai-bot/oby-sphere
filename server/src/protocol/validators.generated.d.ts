// Types for validators.generated.js (scripts/gen-validators.mjs): one ajv validator per schema.

export interface SchemaError {
  instancePath: string;
  message?: string;
  params?: Record<string, unknown>;
}

export interface Validator {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
}

export declare const envelope: Validator;
export declare const sealedEnvelope: Validator;
export declare const runnerStatus: Validator;
export declare const agentCard: Validator;
export declare const auditEntry: Validator;
export declare const createSphereRequest: Validator;
export declare const signinRequest: Validator;
export declare const signinResponse: Validator;
export declare const signinProvidersResponse: Validator;
export declare const invitationRequest: Validator;
export declare const sphereUpdateRequest: Validator;
export declare const invitationPreviewRequest: Validator;
export declare const redeemRequest: Validator;
export declare const cardUpdateRequest: Validator;
export declare const policyPutRequest: Validator;
export declare const ackRequest: Validator;
export declare const jwsHeader: Validator;
export declare const delegationClaims: Validator;
export declare const actorClaims: Validator;
export declare const healthResponse: Validator;
export declare const featuresResponse: Validator;
export declare const sphere: Validator;
export declare const tokenResponse: Validator;
export declare const invitationResponse: Validator;
export declare const invitationsResponse: Validator;
export declare const invitationPreviewResponse: Validator;
export declare const member: Validator;
export declare const membersResponse: Validator;
export declare const policy: Validator;
export declare const sendResponse: Validator;
export declare const deliveriesResponse: Validator;
export declare const ackResponse: Validator;
export declare const auditResponse: Validator;
export declare const a2aSendRequest: Validator;
export declare const a2aSendResponse: Validator;
export declare const a2aTask: Validator;
export declare const a2aError: Validator;
export declare const relay: Validator;
export declare const error: Validator;
