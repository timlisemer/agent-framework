export function isFileSystemErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function isMissingFileError(error: unknown): boolean {
  return isFileSystemErrorCode(error, "ENOENT");
}

export function isAlreadyExistsFileError(error: unknown): boolean {
  return isFileSystemErrorCode(error, "EEXIST");
}
