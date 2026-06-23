export type RuntimeHomeProfile =
  | "native"
  | "managedAstral"
  | "internalDirect"
  | "internalReadOnly"
  | "internalWrite";

export type SessionPolicy = "normal" | "none" | "volatile" | "write";
export type InternalRuntimeDirName = "direct" | "read-only" | "write";
export type RuntimeToolPolicy = "none" | "read-only" | "write";

export type RuntimeProfileDescriptor = {
  sessionPolicy: SessionPolicy;
  internalDirName?: InternalRuntimeDirName;
};

export const RUNTIME_PROFILE_DESCRIPTORS: Record<RuntimeHomeProfile, RuntimeProfileDescriptor> = {
  native: {
    sessionPolicy: "normal",
  },
  managedAstral: {
    sessionPolicy: "normal",
  },
  internalDirect: {
    sessionPolicy: "none",
    internalDirName: "direct",
  },
  internalReadOnly: {
    sessionPolicy: "volatile",
    internalDirName: "read-only",
  },
  internalWrite: {
    sessionPolicy: "write",
    internalDirName: "write",
  },
};

export function runtimeProfileDescriptor(profile: RuntimeHomeProfile): RuntimeProfileDescriptor {
  return RUNTIME_PROFILE_DESCRIPTORS[profile];
}

export function internalRuntimeDirNameForProfile(profile: RuntimeHomeProfile): InternalRuntimeDirName {
  const dirName = runtimeProfileDescriptor(profile).internalDirName;
  if (!dirName) throw new Error(`Runtime profile does not have an internal runtime directory: ${profile}`);
  return dirName;
}
