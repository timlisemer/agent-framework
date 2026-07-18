import "../utils/load-env.js";
import { readClientFrames, writeBackendFrame } from "./wire.js";
import { ScenarioGateway } from "./gateway.js";
import { ScenarioProviderManager } from "./scenario-provider-manager.js";
import { VERSION } from "../version.js";
import { z } from "zod";
import { negotiateScenarioHello } from "../scenario/protocol/negotiation.js";
import { scenarioGatewayScopes } from "../scenario/protocol/gateway.js";
import { scenarioVisibilityValues } from "../scenario/protocol/common.js";
import {
  MAXIMUM_ARTIFACT_BYTES,
  MAXIMUM_CLIENT_FRAME_BYTES,
} from "../scenario/protocol/limits.js";

const TRUSTED_AUTHORITY_ENV = "AGENT_FRAMEWORK_TRUSTED_SCENARIO_AUTHORITY";
const trustedAuthoritySchema = z.object({
  subjectId: z.string().min(1),
  clientId: z.string().min(1),
  clientVersion: z.string().min(1),
  scopes: z.array(z.string()),
  visibilityScope: z.array(z.string()),
}).strict();

function trustedProcessAuthority(): z.infer<typeof trustedAuthoritySchema> {
  const encoded = process.env[TRUSTED_AUTHORITY_ENV];
  if (!encoded) {
    return {
      subjectId: "local-user",
      clientId: "local-stdio",
      clientVersion: VERSION,
      scopes: [...scenarioGatewayScopes],
      visibilityScope: [...scenarioVisibilityValues],
    };
  }
  return trustedAuthoritySchema.parse(JSON.parse(encoded));
}

const manager = new ScenarioProviderManager();
const gatewayRef: { current?: ScenarioGateway } = {};
let scenarioNegotiated = false;

try {
  await readClientFrames(
    async (frame) => {
      if (frame.type === "hello") {
        const negotiation = negotiateScenarioHello(frame);
        if (!negotiation.ok) {
          scenarioNegotiated = false;
          await gatewayRef.current?.dispose();
          gatewayRef.current = undefined;
          writeBackendFrame({
            type: "response",
            requestId: "hello-negotiation",
            ok: false,
            payload: {
              kind: "error",
              code: negotiation.code,
              message: negotiation.message,
              recoverable: false,
            },
          });
          return;
        }
        const supportedCapabilities = scenarioGatewayScopes;
        const requestedCapabilities = supportedCapabilities.filter((capability) =>
          frame.capabilities.includes(capability)
        );
        const processAuthority = trustedProcessAuthority();
        const negotiatedCapabilities = requestedCapabilities.filter((capability) =>
          processAuthority.scopes.includes(capability)
        );
        const supportedVisibilityScope = scenarioVisibilityValues;
        const negotiatedVisibilityScope = supportedVisibilityScope.filter((visibility) =>
          processAuthority.visibilityScope.includes(visibility)
        );
        await gatewayRef.current?.dispose();
        gatewayRef.current = new ScenarioGateway(manager.runtime, {
          emit: writeBackendFrame,
          providerHost: manager.host,
          authority: {
            subjectId: processAuthority.subjectId,
            clientId: processAuthority.clientId,
            clientVersion: processAuthority.clientVersion,
            scopes: negotiatedCapabilities,
            visibilityScope: negotiatedVisibilityScope,
          },
        });
        scenarioNegotiated = true;
        writeBackendFrame({
          type: "welcome",
          subjectId: processAuthority.subjectId,
          engineVersion: VERSION,
          schemaDigest: negotiation.schemaDigest,
          capabilities: negotiatedCapabilities,
          maximumFrameBytes: MAXIMUM_CLIENT_FRAME_BYTES,
          maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
          visibilityScope: [...negotiatedVisibilityScope],
          extensionSchemas: [],
        });
        return;
      }
      if (frame.type === "request" && "payload" in frame) {
        if (!scenarioNegotiated) {
          writeBackendFrame({
            type: "response",
            requestId: frame.requestId,
            ok: false,
            payload: {
              kind: "error",
              code: "protocol_not_negotiated",
              message: "Scenario hello/welcome negotiation is required before requests",
              recoverable: true,
            },
          });
          return;
        }
        writeBackendFrame(await gatewayRef.current!.handle(frame));
        return;
      }
    },
    undefined,
    () => {
      writeBackendFrame({
        type: "response",
        requestId: "invalid-frame",
        ok: false,
        payload: {
          kind: "error",
          code: "invalid_request",
          message: "Invalid request frame",
          recoverable: true,
        },
      });
    }
  );
} catch (error) {
  writeBackendFrame({
    type: "response",
    requestId: "runtime-failure",
    ok: false,
    payload: {
      kind: "error",
      code: "runtime_error",
      message: "Runtime operation failed",
      recoverable: false,
    },
  });
  process.exitCode = 1;
} finally {
  await gatewayRef.current?.dispose();
  await manager.dispose();
}
