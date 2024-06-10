import path from "node:path";

import { assertHardhatInvariant } from "@nomicfoundation/hardhat-errors";
import { ensureError } from "@nomicfoundation/hardhat-utils/error";
import {
  FileNotFoundError,
  exists,
  getFileTrueCase,
  getRealPath,
  readJsonFile,
  readUtf8File,
} from "@nomicfoundation/hardhat-utils/fs";

import {
  Remapping,
  applyValidRemapping,
  parseRemappingString,
  selectBestRemapping,
} from "./remappings.js";
import { resolve } from "./resolve.js";

// We do not support package.json#exports
// We do not allow users to remap the imports within npm packages
// Project root is the folder with the closes package.json to the config file!!!
// For `hardhat/` we only remap `hardhat/console.sol`

// TODO: Windows and source names with \ instead of /

export enum ResolvedFileType {
  PROJECT_FILE = "PROJECT_FILE",
  REPOSITORY_PACKAGE_FILE = "REPOSITORY_FILE",
  NPM_PACKGE_FILE = "NPM_PACKAGE_FILE",
}

interface ProjectResolvedFile {
  type: ResolvedFileType.PROJECT_FILE;
  sourceName: string;
  path: string;
  content: string;
}

interface NpmPackage {
  name: string;
  version: string;
  rootPath: string;
  rootSourceName: string;
}

interface NpmPackageResolvedFile {
  type: ResolvedFileType.NPM_PACKGE_FILE;
  sourceName: string;
  path: string;
  content: string;
  package: NpmPackage;
}

export type ResolvedFile = ProjectResolvedFile | NpmPackageResolvedFile;

interface UserRemapping {
  rawFormat: string;
  context: string;
  prefix: string;
  target: string;
  targetNpmPackage?: NpmPackage;
}

const PROJECT_ROOT_SOURCE_NAME_SENTINEL: unique symbol = Symbol();

export interface Resolver {
  resolveProjectFile(absoluteFilePath: string): Promise<ProjectResolvedFile>;
  resolveImport(from: ResolvedFile, importPath: string): Promise<ResolvedFile>;
  getRemappings(): Remapping[];
}

export class ResolverImplementation implements Resolver {
  // A map of all the npm dependencies used in the project and its dependencies
  readonly #dependencyMaps: Map<
    string | typeof PROJECT_ROOT_SOURCE_NAME_SENTINEL, // The package's root sourceName
    Map<
      string, // The package that is being imported, as the package name in the import
      NpmPackage | typeof PROJECT_ROOT_SOURCE_NAME_SENTINEL
    >
  > = new Map();

  readonly #projectRoot: string;
  readonly #workingDirectory: string;
  readonly #userRemappings: UserRemapping[];

  // A cache from absolute path to resolved file
  readonly #cacheBySourceName: Map<string, ResolvedFile> = new Map();

  public static async create(
    projectRoot: string,
    userRemappingStrings: string[],
    workingDirectory?: string,
  ): Promise<Resolver> {
    const userRemappings = await Promise.all(
      userRemappingStrings.map((remappingString) =>
        validateAndResolveRemapping(projectRoot, remappingString),
      ),
    );

    return new ResolverImplementation(
      workingDirectory !== undefined
        ? await getRealPath(workingDirectory)
        : process.cwd(),
      projectRoot,
      userRemappings,
    );
  }

  private constructor(
    workingDirectory: string,
    projectRoot: string,
    userRemappings: UserRemapping[],
  ) {
    this.#projectRoot = projectRoot;
    this.#workingDirectory = workingDirectory;
    this.#userRemappings = userRemappings;
    this.#dependencyMaps.set(PROJECT_ROOT_SOURCE_NAME_SENTINEL, new Map());
  }

  public async resolveProjectFile(
    absoluteFilePath: string,
  ): Promise<ProjectResolvedFile> {
    const relativeFilePath = path.relative(this.#projectRoot, absoluteFilePath);

    const sourceName = relativeFilePath;
    const cached = this.#cacheBySourceName.get(sourceName);
    if (cached !== undefined) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
      The cache is type-unsafe, but we are sure this is a ProjectResolvedFile */
      return cached as ProjectResolvedFile;
    }

    if (!absoluteFilePath.startsWith(this.#projectRoot)) {
      throw new Error(
        `Trying to resolve project file ${absoluteFilePath}, but it's not within the project`,
      );
    }

    let trueCasePath: string;
    try {
      trueCasePath = await getFileTrueCase(this.#projectRoot, relativeFilePath);
    } catch (error) {
      ensureError(error, FileNotFoundError);

      throw new Error(
        `Project file doesn't exist: ${this.#userFriendlyPath(absoluteFilePath)}`,
        {
          cause: error,
        },
      );
    }

    if (trueCasePath !== relativeFilePath) {
      throw new Error(
        `Trying to resolve local file ${absoluteFilePath} with invalid casing, it should be ${path.join(this.#projectRoot, trueCasePath)}`,
      );
    }

    const resolvedFile: ProjectResolvedFile = {
      type: ResolvedFileType.PROJECT_FILE,
      sourceName,
      path: absoluteFilePath,
      content: await readUtf8File(absoluteFilePath),
    };

    this.#cacheBySourceName.set(sourceName, resolvedFile);

    return resolvedFile;
  }

  public async resolveImport(
    from: ResolvedFile,
    importPath: string,
  ): Promise<ResolvedFile> {
    let directImport = importPath;

    if (importPath.startsWith("./") || importPath.startsWith("../")) {
      directImport = path.join(path.dirname(from.sourceName), importPath);

      if (from.type === ResolvedFileType.NPM_PACKGE_FILE) {
        if (!directImport.startsWith(from.package.rootSourceName)) {
          throw new Error(
            `Invalid import ${importPath} from ${this.#userFriendlyPath(from.path)}, trying to import outside of the package`,
          );
        }
      } else {
        if (directImport.startsWith("../")) {
          throw new Error(
            `Invalid import ${importPath} from ${this.#userFriendlyPath(from.path)}, trying to import outside of the project`,
          );
        }
      }
    }

    switch (from.type) {
      case ResolvedFileType.PROJECT_FILE:
        return this.#resolveImportFromProjectFile({
          from,
          importPath,
          directImport,
        });

      case ResolvedFileType.NPM_PACKGE_FILE:
        return this.#resolveImportFromNpmPackageFile({
          from,
          importPath,
          directImport,
        });
    }
  }

  public getRemappings(): Remapping[] {
    const remappings = this.#userRemappings.map((remapping) => ({
      context: remapping.context,
      prefix: remapping.prefix,
      target: remapping.target,
    }));

    let hasNpmRemappings = false;

    for (const [
      fromPackageSourceName,
      dependenciesMap,
    ] of this.#dependencyMaps.entries()) {
      for (const [importedPackage, dependency] of dependenciesMap.entries()) {
        if (!hasNpmRemappings) {
          remappings.push({
            context: "npm/",
            prefix: "npm/",
            target: "npm/",
          });

          hasNpmRemappings = true;
        }

        const context =
          fromPackageSourceName === PROJECT_ROOT_SOURCE_NAME_SENTINEL
            ? ""
            : fromPackageSourceName;

        const prefix = importedPackage + "/";

        const target =
          dependency === PROJECT_ROOT_SOURCE_NAME_SENTINEL
            ? ""
            : dependency.rootSourceName;

        remappings.push({ context, prefix, target });
      }
    }

    return remappings;
  }

  // >>>>>>>>>> BEGIN SECTION: Import resolution selection
  //
  // The private methods in this section are in charge of selecting which import
  // resolution technique to use, but they don't create any ResolvedFile.
  //
  // These techniques are:
  //  1. Resolving an import to a project file
  //  2. Resolving an import to an npm package remapped by the user
  //  3. Resolving an import from an npm package to one of its files
  //  4. Resolving an import to a different npm package using our own remmapings

  /**
   * Resolves an import from a project file.
   *
   * This method applies the user remappings, if necessary, and uses the
   * appropriate resolution technique.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param directImport The direct import path, after resolving relative paths,
   * but before applying any remapping.
   */
  async #resolveImportFromProjectFile({
    from,
    importPath,
    directImport,
  }: {
    from: ProjectResolvedFile;
    directImport: string;
    importPath: string;
  }): Promise<ResolvedFile> {
    const bestUserRemapping = selectBestRemapping(
      from.sourceName,
      directImport,
      this.#userRemappings,
    );

    if (bestUserRemapping !== undefined) {
      const remappedDirectImport = applyValidRemapping(
        directImport,
        bestUserRemapping,
      );

      // Special case, where a user remapping's target is an npm pacakge
      if (bestUserRemapping.targetNpmPackage !== undefined) {
        return this.#resolveImportToNpmPackageRemappedByUser({
          from,
          importPath,
          directImport: remappedDirectImport,
          // This weird syntax is because TS doesn't realize that
          // bestUserRemapping is Required<UserRemapping> here
          remapping: {
            ...bestUserRemapping,
            targetNpmPackage: bestUserRemapping.targetNpmPackage,
          },
        });
      }

      if (
        await this.#isDirectImportLocal(this.#projectRoot, remappedDirectImport)
      ) {
        return this.#resolveImportToProjectFile({
          from,
          importPath,
          pathWithinTheProject: remappedDirectImport,
        });
      }

      throw new Error(
        `Applying the remapping "${bestUserRemapping.rawFormat}" to the import ${importPath} from ${this.#userFriendlyPath(from.path)} results in an invalid import ${remappedDirectImport}, as it's not a local files. If you are trying to remap into an npm module use the npm/ syntax instead.`,
      );
    }

    if (await this.#isDirectImportLocal(this.#projectRoot, directImport)) {
      return this.#resolveImportToProjectFile({
        from,
        importPath,
        pathWithinTheProject: directImport,
      });
    }

    return this.#resolveImportThroughNpm({ from, importPath, directImport });
  }

  /**
   * Resolves an import from an npm file.
   *
   * This method does not apply any remapping that may be present in the npm
   * package.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param directImport The direct import path, after resolving relative paths,
   * but without applying any remapping.
   */
  async #resolveImportFromNpmPackageFile({
    from,
    importPath,
    directImport,
  }: {
    from: NpmPackageResolvedFile;
    directImport: string;
    importPath: string;
  }): Promise<ResolvedFile> {
    // If we wanted to apply its own remappings, this would be the place.
    // Initially we won't support it.

    //  This was a relative import that got resolved
    if (directImport.startsWith(from.package.rootSourceName)) {
      return this.#resolveLocalImportFromNpmPackage({
        from,
        importPath,
        directImport,
      });
    }

    // This was already a direct import, and may be to the same package.
    // As we allow this imports in the local project files, we should also allow
    // them on npm packages. If we don't projects won't be easily distributable
    // through npm, even if they don't use remappings.
    if (await this.#isDirectImportLocal(from.package.rootPath, directImport)) {
      return this.#resolveLocalImportFromNpmPackage({
        from,
        importPath,
        directImport: from.package.rootSourceName + directImport,
      });
    }

    return this.#resolveImportThroughNpm({ from, importPath, directImport });
  }

  /**
   * This method resolves an import that has to go through the npm resolution
   * process and selects the appropriate technique to resolve it.
   *
   * This method does not apply nor define any remapping, but it populates the
   * `#dependencyMaps` with dependencies that each package uses, so that we can
   * create all the necessary remappings at the end of the resolution process.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param directImport The direct import path, after resolving relative paths,
   * but without applying any remapping.
   */
  async #resolveImportThroughNpm({
    from,
    importPath,
    directImport,
  }: {
    from: ResolvedFile;
    importPath: string;
    directImport: string;
  }): Promise<ResolvedFile> {
    const parsedDirectImport = this.#parseNpmDirectImport(directImport);

    if (parsedDirectImport === undefined) {
      throw new Error(`Invalid npm import ${directImport}`);
    }

    const dependencyMapsKey =
      from.type === ResolvedFileType.PROJECT_FILE
        ? PROJECT_ROOT_SOURCE_NAME_SENTINEL
        : from.package.rootSourceName;

    if (!this.#dependencyMaps.has(dependencyMapsKey)) {
      this.#dependencyMaps.set(dependencyMapsKey, new Map());
    }

    const dependenciesMap = this.#dependencyMaps.get(dependencyMapsKey);

    assertHardhatInvariant(
      dependenciesMap !== undefined,
      "We set the dependency map right above",
    );

    if (!dependenciesMap.has(parsedDirectImport.package)) {
      let newDependency: NpmPackage | typeof PROJECT_ROOT_SOURCE_NAME_SENTINEL;

      const baseResolutionDirectory =
        from.type === ResolvedFileType.PROJECT_FILE
          ? this.#projectRoot
          : from.package.rootPath;

      const packageJsonPath = resolve({
        from: baseResolutionDirectory,
        importPath: parsedDirectImport.package + "/package.json",
      });

      if (packageJsonPath === undefined) {
        if (from.type === ResolvedFileType.PROJECT_FILE) {
          throw new Error(
            `Import "${importPath}" from "${this.#userFriendlyPath(from.path)}" can't be resolved because the package "${parsedDirectImport.package}" is not installed`,
          );
        }

        throw new Error(
          `Import "${importPath}" from "${this.#userFriendlyPath(from.path)}" can't be resolved because the package "${parsedDirectImport.package}" is not installed for "${from.package.name}@${from.package.version}"`,
        );
      }

      const packageJson = await readJsonFile<{ name: string; version: string }>(
        packageJsonPath,
      );

      if (isPackageJsonFromProject(packageJsonPath, this.#projectRoot)) {
        newDependency = PROJECT_ROOT_SOURCE_NAME_SENTINEL;
      } else {
        const name = packageJson.name;
        const version = isPackageJsonFromMonorepo(
          packageJsonPath,
          this.#projectRoot,
        )
          ? "local"
          : packageJson.version;

        const npmPackage: NpmPackage = {
          name,
          version,
          rootPath: path.dirname(packageJsonPath),
          rootSourceName: npmPackageToRootSourceName(name, version),
        };

        newDependency = npmPackage;
      }

      dependenciesMap.set(parsedDirectImport.package, newDependency);
    }

    const dependency = dependenciesMap.get(parsedDirectImport.package);
    assertHardhatInvariant(
      dependency !== undefined,
      "We set the dependency right above",
    );

    if (dependency === PROJECT_ROOT_SOURCE_NAME_SENTINEL) {
      return this.#resolveImportToProjectFile({
        from,
        importPath,
        // If we import a file through npm and end up in the Hardhat project,
        // we are going to remap the package name to "", so that the path
        // section of the parsed direct is in fact the directImport in the
        // context of the package.
        pathWithinTheProject: parsedDirectImport.path,
      });
    }

    return this.#resolveImportToNpmPackage({
      from,
      importPath,
      importedPackage: dependency,
      pathWithinThePackage: parsedDirectImport.path,
    });
  }

  // >>>>>>>>>> END SECTION: Import resolution selection

  // >>>>>>>>>> BEGIN SECTION: Import resolution techniques
  //
  // The private methods in this section implement the different import
  // import resolution techniques, which have been explained in the previous
  // section.

  /**
   * This method implements the import resolution technique number 1: Importing
   * a file that is within the project. Note that this method applies both to
   * imports from project files as well as imports from npm packages that may
   * have the project as a dependency.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param pathWithinTheProject The path within the project to import, after
   * normalizing relative paths, applying user remappings and/or stripping the
   * npm package name.
   */
  async #resolveImportToProjectFile({
    from,
    importPath,
    pathWithinTheProject,
  }: {
    from: ResolvedFile;
    importPath: string;
    pathWithinTheProject: string;
  }): Promise<ProjectResolvedFile> {
    const sourceName = pathWithinTheProject;
    const cached = this.#cacheBySourceName.get(sourceName);
    if (cached !== undefined) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
      The cache is type-unsafe, but we are sure this is a ProjectResolvedFile */
      return cached as ProjectResolvedFile;
    }

    // This is a project file, so if it was imported from a local file, this
    // is the direct import, without any remapping or necessary consideration.
    // If this was imported from an npm package, we are remapping the package
    // name to "", so that the direct import is the same as the relative path.
    const relativePath = pathWithinTheProject;
    await this.#validateExistanceAndCasingOfImport({
      from,
      importPath,
      relativePathToValidate: relativePath,
      absolutePathToValidateFrom: this.#projectRoot,
    });

    const filePath = path.join(this.#projectRoot, relativePath);

    const resolvedFile: ProjectResolvedFile = {
      type: ResolvedFileType.PROJECT_FILE,
      sourceName,
      path: filePath,
      content: await readUtf8File(filePath),
    };

    this.#cacheBySourceName.set(sourceName, resolvedFile);

    return resolvedFile;
  }

  /**
   * This method implements the import resolution technique number 2: A project
   * file has an import that should be resolved to a file in an npm package due
   * to a user remapping.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param directImport The direct import path, after resolving relative paths,
   * and applying the user remapping.
   * @param remapping The remapping that was applied.
   */
  async #resolveImportToNpmPackageRemappedByUser({
    from,
    importPath,
    directImport,
    remapping,
  }: {
    from: ProjectResolvedFile;
    importPath: string;
    directImport: string;
    remapping: Required<UserRemapping>;
  }): Promise<NpmPackageResolvedFile> {
    const sourceName = directImport;
    const cached = this.#cacheBySourceName.get(sourceName);
    if (cached !== undefined) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
      The cache is type-unsafe, but we are sure this is a NpmPackageResolvedFile */
      return cached as NpmPackageResolvedFile;
    }

    const relativeFilePath = path.relative(
      npmPackageToRootSourceName(
        remapping.targetNpmPackage.name,
        remapping.targetNpmPackage.version,
      ),
      directImport,
    );

    // We don't add the dependency to `this.#dependencyMaps` because we
    // don't need a new remapping for this package, as it's already
    // remapped by the user.

    await this.#validateExistanceAndCasingOfImport({
      from,
      importPath,
      relativePathToValidate: relativeFilePath,
      absolutePathToValidateFrom: remapping.targetNpmPackage.rootPath,
    });

    const filePath = path.join(
      remapping.targetNpmPackage.rootPath,
      relativeFilePath,
    );

    const resolvedFile: NpmPackageResolvedFile = {
      type: ResolvedFileType.NPM_PACKGE_FILE,
      sourceName,
      path: filePath,
      content: await readUtf8File(filePath),
      package: remapping.targetNpmPackage,
    };

    this.#cacheBySourceName.set(sourceName, resolvedFile);

    return resolvedFile;
  }

  /**
   * This method implements the import resolution technique number 3: A file
   * from an npm package is importing another file from the same package.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param directImport The direct import path, after resolving relative paths.
   * It must start with the package's root source name.
   */
  async #resolveLocalImportFromNpmPackage({
    from,
    importPath,
    directImport,
  }: {
    from: NpmPackageResolvedFile;
    directImport: string;
    importPath: string;
  }): Promise<NpmPackageResolvedFile> {
    const sourceName = directImport;
    const cached = this.#cacheBySourceName.get(sourceName);
    if (cached !== undefined) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
      The cache is type-unsafe, but we are sure this is a NpmPackageResolvedFile */
      return cached as NpmPackageResolvedFile;
    }

    const relativePath = path.relative(
      from.package.rootSourceName,
      directImport,
    );

    await this.#validateExistanceAndCasingOfImport({
      from,
      importPath,
      relativePathToValidate: relativePath,
      absolutePathToValidateFrom: from.package.rootPath,
    });

    const filePath = path.join(from.package.rootPath, directImport);

    const resolvedFile: NpmPackageResolvedFile = {
      type: ResolvedFileType.NPM_PACKGE_FILE,
      sourceName,
      path: filePath,
      content: await readUtf8File(filePath),
      package: from.package,
    };

    this.#cacheBySourceName.set(sourceName, resolvedFile);
    return resolvedFile;
  }

  /**
   * This method implements the import resolution technique number 4: A file,
   * within the project or from an npm pacakge, is importing a file from a
   * different npm package.
   *
   * @param from The file from which the import is being resolved.
   * @param importPath The import path, as written in the source code.
   * @param importedPackage The NpmPackage that is being imported.
   * @param pathWithinThePackage The path to the file to import, within the
   * package. That means, after parsing the direct import, and stripping the
   * package part.
   */
  async #resolveImportToNpmPackage({
    from,
    importPath,
    importedPackage,
    pathWithinThePackage,
  }: {
    from: ResolvedFile;
    importPath: string;
    importedPackage: NpmPackage;
    pathWithinThePackage: string;
  }): Promise<NpmPackageResolvedFile> {
    const sourceName = importedPackage.rootSourceName + pathWithinThePackage;
    const cached = this.#cacheBySourceName.get(sourceName);
    if (cached !== undefined) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions --
      The cache is type-unsafe, but we are sure this is a NpmPackageResolvedFile */
      return cached as NpmPackageResolvedFile;
    }

    await this.#validateExistanceAndCasingOfImport({
      from,
      importPath,
      relativePathToValidate: pathWithinThePackage,
      absolutePathToValidateFrom: importedPackage.rootPath,
    });

    const filePath = path.join(importedPackage.rootPath, pathWithinThePackage);

    const resolvedFile: NpmPackageResolvedFile = {
      type: ResolvedFileType.NPM_PACKGE_FILE,
      sourceName,
      path: filePath,
      content: await readUtf8File(filePath),
      package: importedPackage,
    };

    this.#cacheBySourceName.set(sourceName, resolvedFile);

    return resolvedFile;
  }

  // >>>>>>>>>> END SECTION: Import resolution techniques

  /**
   * This method returns true if a direct import should be considered an import
   * to a local file when evaluated in the context of the Hardhat project.
   */
  async #isDirectImportLocal(
    projectOrPackageRoot: string,
    directImport: string,
  ): Promise<boolean> {
    if (directImport === "hardhat/console.sol") {
      return false;
    }

    const slash = directImport.indexOf("/");

    // If it's a file in the root directory
    if (slash === -1) {
      return true;
    }

    const firstDirectory = directImport.substring(0, slash);

    // TODO: Cache this
    return exists(path.join(projectOrPackageRoot, firstDirectory));
  }

  /**
   * This is an utility method that validates the existance and casing of an
   * imported file as part of the different resolution techniques.
   *
   * `from` and `importPath` are used to provide a user-friendly error message,
   * but the actual validation is done using `relativePathToValidate` and
   * `absolutePathToValidateFrom`.
   *
   * @param from The file with the import.
   * @param importPath The import path, as written in the source code.
   * @param relativePathToValidate The relative path to validate its existance.
   * @param absolutePathToValidateFrom The absolute path from in which the
   * relative path is.
   */
  async #validateExistanceAndCasingOfImport({
    from,
    importPath,
    relativePathToValidate,
    absolutePathToValidateFrom,
  }: {
    from: ResolvedFile;
    importPath: string;
    relativePathToValidate: string;
    absolutePathToValidateFrom: string;
  }) {
    let trueCasePath: string;
    try {
      trueCasePath = await getFileTrueCase(
        absolutePathToValidateFrom,
        relativePathToValidate,
      );
    } catch (error) {
      ensureError(error, FileNotFoundError);

      throw new Error(
        `Import ${importPath} from ${this.#userFriendlyPath(from.path)} not found`,
        { cause: error },
      );
    }

    if (relativePathToValidate !== trueCasePath) {
      throw new Error(
        `Import ${importPath} from ${this.#userFriendlyPath(from.path)} has an incorrect casing. Try importing ${trueCasePath} instead.`,
      );
    }
  }

  /**
   * Normalizes a path to be user-friendly, by making it relative to the working
   * directory if it's within it.
   */
  #userFriendlyPath(from: string): string {
    if (from.startsWith(this.#workingDirectory)) {
      return path.relative(this.#workingDirectory, from);
    }

    return from;
  }

  /**
   * Parses a direct import as if it were an npm import, returning `undefined`
   * if the format is invalid.
   */
  #parseNpmDirectImport(directImport: string):
    | {
        package: string;
        path: string;
      }
    | undefined {
    const directImportPattern =
      /^(?<package>(?:@[a-z0-9-~._]+\/)?[a-z0-9-~][a-z0-9-~._]*)\/(?<path>.*)$/;

    const match = directImportPattern.exec(directImport);

    if (match === null) {
      return undefined;
    }

    assertHardhatInvariant(
      match.groups !== undefined,
      "Groups should be defined because they are part of the pattern",
    );

    return { package: match.groups.package, path: match.groups.path };
  }
}

async function validateAndResolveRemapping(
  projectRoot: string,
  remappingString: string,
): Promise<UserRemapping> {
  const remapping = parseRemappingString(remappingString);

  if (remapping.context.startsWith("npm/")) {
    throw new Error(
      `Invalid remapping: context starting with npm/ is not allowed in ${remappingString}`,
    );
  }

  if (!remapping.target.startsWith("npm/")) {
    return { ...remapping, rawFormat: remappingString };
  }

  const parsed = parseNpmRemappingTarget(remapping.target);

  if (parsed === undefined) {
    throw new Error(`Invalid remapping with npm target: ${remappingString}`);
  }

  const { packageName, packageVersion } = parsed;

  const dependencyPackageJsonPath = resolve({
    from: projectRoot,
    importPath: `${packageName}/package.json`,
  });

  if (dependencyPackageJsonPath === undefined) {
    throw new Error(`The package ${packageName} is not installed`);
  }

  if (isPackageJsonFromMonorepo(dependencyPackageJsonPath, projectRoot)) {
    if (packageVersion !== "local") {
      throw new Error(
        `The package ${packageName} was expected to be part of the monorepo, but it is installed through npm instead`,
      );
    }
  }

  if (isPackageJsonFromProject(dependencyPackageJsonPath, projectRoot)) {
    throw new Error(
      `You shouldn't remap ${packageName} to a local npm package, as it is part of your project`,
    );
  }

  if (isPackageJsonFromNpmPackage(dependencyPackageJsonPath)) {
    const dependencyPackageJson = await readJsonFile<{ version: string }>(
      dependencyPackageJsonPath,
    );

    if (dependencyPackageJson.version !== packageVersion) {
      throw new Error(
        `The package ${packageName} is installed, but it is not the expected version`,
      );
    }
  }

  const npmPackage: NpmPackage = {
    name: packageName,
    version: packageVersion,
    rootPath: path.dirname(dependencyPackageJsonPath),
    rootSourceName: npmPackageToRootSourceName(packageName, packageVersion),
  };

  return {
    ...remapping,
    targetNpmPackage: npmPackage,
    rawFormat: remappingString,
  };
}

function parseNpmRemappingTarget(remappingTarget: string):
  | {
      packageName: string;
      packageVersion: string;
    }
  | undefined {
  const npmTargetPattern =
    /^npm\/(?<package>(?:@[a-z0-9-~._]+\/)?[a-z0-9-~][a-z0-9-~._]*)@(?<version>local|\d+\.\d+\.\d+)\//;

  const match = npmTargetPattern.exec(remappingTarget);

  if (match === null) {
    return undefined;
  }

  assertHardhatInvariant(
    match.groups !== undefined,
    "Groups should be defined because they are part of the pattern",
  );

  return {
    packageName: match.groups.package,
    packageVersion: match.groups.version,
  };
}

function npmPackageToRootSourceName(name: string, version: string): string {
  return `npm/${name}@${version}/`;
}

function isPackageJsonFromMonorepo(
  packageJsonPath: string,
  projectRoot: string,
): boolean {
  return (
    !packageJsonPath.includes("node_modules") &&
    !packageJsonPath.startsWith(projectRoot)
  );
}

function isPackageJsonFromProject(
  packageJsonPath: string,
  projectRoot: string,
): boolean {
  return (
    !packageJsonPath.includes("node_modules") &&
    packageJsonPath.startsWith(projectRoot)
  );
}

function isPackageJsonFromNpmPackage(packageJsonPath: string): boolean {
  return packageJsonPath.includes("node_modules");
}
