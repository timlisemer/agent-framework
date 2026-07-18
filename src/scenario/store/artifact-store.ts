import fsModule from "fs";
import * as path from "path";
import { hashSha256 } from "../../utils/hash-utils.js";
import { isMissingFileError } from "../../utils/filesystem-errors.js";
import type { ArtifactRef } from "../protocol/artifacts.js";
import type { ScenarioVisibility } from "../protocol/common.js";
import { writeFileAtomically } from "../../utils/file-io.js";
import { isPathAtOrInside } from "../../utils/path-containment.js";

const fs = fsModule.promises;

export type ArtifactPutResult = {
  reference: ArtifactRef;
  created: boolean;
};

export class ArtifactStore {
  public constructor(private readonly artifactsDir: string) {}

  public async put(input: {
    bytes: Uint8Array;
    mediaType: string;
    visibility: ScenarioVisibility;
    preview?: string;
  }): Promise<ArtifactRef> {
    return (await this.putTracked(input)).reference;
  }

  public async putTracked(input: {
    bytes: Uint8Array;
    mediaType: string;
    visibility: ScenarioVisibility;
    preview?: string;
  }): Promise<ArtifactPutResult> {
    await this.requireGenuineArtifactsDirectory(true);
    const hex = hashSha256(input.bytes);
    const digest = `sha256:${hex}`;
    const artifactPath = path.join(this.artifactsDir, hex);
    const reference: ArtifactRef = {
      artifactId: hex,
      digest,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      visibility: input.visibility,
      ...(input.preview === undefined ? {} : { preview: input.preview }),
    };
    try {
      await fs.lstat(artifactPath);
      await this.get(reference);
      return { reference, created: false };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await writeFileAtomically(artifactPath, input.bytes);
    return { reference, created: true };
  }

  public async get(reference: ArtifactRef): Promise<Uint8Array> {
    await this.requireGenuineArtifactsDirectory(false);
    const artifactPath = this.entryPath(reference.artifactId);
    const entry = await fs.lstat(artifactPath);
    if (!entry.isFile()) throw new Error(`Artifact path is not a regular file: ${reference.artifactId}`);
    const handle = await fs.open(
      artifactPath,
      fsModule.constants.O_RDONLY | fsModule.constants.O_NOFOLLOW,
    );
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error(`Artifact path is not a regular file: ${reference.artifactId}`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const digest = `sha256:${hashSha256(bytes)}`;
    if (digest !== reference.digest) throw new Error(`Artifact digest mismatch for ${reference.artifactId}`);
    if (bytes.byteLength !== reference.byteLength) {
      throw new Error(`Artifact length mismatch for ${reference.artifactId}`);
    }
    return bytes;
  }

  public async remove(reference: ArtifactRef): Promise<void> {
    await this.removeEntry(reference.artifactId);
  }

  public async entries(): Promise<string[]> {
    try {
      await this.requireGenuineArtifactsDirectory(false);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    return fs.readdir(this.artifactsDir);
  }

  public async removeEntry(entry: string): Promise<void> {
    try {
      await this.requireGenuineArtifactsDirectory(false);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    const entryPath = this.entryPath(entry);
    let stat;
    try {
      stat = await fs.lstat(entryPath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      return;
    }
    if (!stat.isFile()) throw new Error(`Artifact path is not a regular file: ${entry}`);
    await fs.unlink(entryPath);
  }

  private entryPath(entry: string): string {
    if (!entry || entry === "." || entry === ".." || path.basename(entry) !== entry) {
      throw new Error(`Artifact entry is not a flat filename: ${JSON.stringify(entry)}`);
    }
    return path.join(this.artifactsDir, entry);
  }

  private async requireGenuineArtifactsDirectory(create: boolean): Promise<void> {
    const runDir = path.dirname(this.artifactsDir);
    const runStat = await fs.lstat(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw new Error("Artifact parent is not a genuine run directory");
    }
    let artifactsStat;
    try {
      artifactsStat = await fs.lstat(this.artifactsDir);
    } catch (error) {
      if (!create || !isMissingFileError(error)) throw error;
      await fs.mkdir(this.artifactsDir);
      artifactsStat = await fs.lstat(this.artifactsDir);
    }
    if (artifactsStat.isSymbolicLink() || !artifactsStat.isDirectory()) {
      throw new Error("Artifact path is not a genuine directory");
    }
    const [resolvedRun, resolvedArtifacts] = await Promise.all([
      fs.realpath(runDir),
      fs.realpath(this.artifactsDir),
    ]);
    if (!isPathAtOrInside(resolvedArtifacts, resolvedRun) || path.dirname(resolvedArtifacts) !== resolvedRun) {
      throw new Error("Artifact directory escapes its canonical run directory");
    }
  }
}
