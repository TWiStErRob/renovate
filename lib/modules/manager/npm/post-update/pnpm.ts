import is from '@sindresorhus/is';
import { load } from 'js-yaml';
import upath from 'upath';
import { GlobalConfig } from '../../../../config/global';
import { TEMPORARY_ERROR } from '../../../../constants/error-messages';
import { logger } from '../../../../logger';
import { exec } from '../../../../util/exec';
import type {
  ExecOptions,
  ExtraEnv,
  ToolConstraint,
} from '../../../../util/exec/types';
import { deleteLocalFile, readLocalFile } from '../../../../util/fs';
import type { PostUpdateConfig, Upgrade } from '../../types';
import type { NpmPackage } from '../extract/types';
import { getNodeToolConstraint } from './node-version';
import type { GenerateLockFileResult, PnpmLockFile } from './types';

function getPnpmConstraintFromUpgrades(upgrades: Upgrade[]): string | null {
  for (const upgrade of upgrades) {
    if (upgrade.depName === 'pnpm' && upgrade.newVersion) {
      return upgrade.newVersion;
    }
  }
  return null;
}

export async function generateLockFile(
  lockFileDir: string,
  env: NodeJS.ProcessEnv,
  config: PostUpdateConfig,
  upgrades: Upgrade[] = []
): Promise<GenerateLockFileResult> {
  const lockFileName = upath.join(lockFileDir, 'pnpm-lock.yaml');
  logger.debug(`Spawning pnpm install to create ${lockFileName}`);
  let lockFile: string | null = null;
  let stdout: string | undefined;
  let stderr: string | undefined;
  let cmd = 'pnpm';
  try {
    const pnpmToolConstraint: ToolConstraint = {
      toolName: 'pnpm',
      constraint:
        getPnpmConstraintFromUpgrades(upgrades) ??
        config.constraints?.pnpm ??
        (await getPnpmConstraint(lockFileDir)),
    };

    const extraEnv: ExtraEnv = {
      NPM_CONFIG_CACHE: env.NPM_CONFIG_CACHE,
      npm_config_store: env.npm_config_store,
    };
    const execOptions: ExecOptions = {
      cwdFile: lockFileName,
      extraEnv,
      docker: {},
      toolConstraints: [
        await getNodeToolConstraint(config, upgrades, lockFileDir),
        pnpmToolConstraint,
      ],
    };
    // istanbul ignore if
    if (GlobalConfig.get('exposeAllEnv')) {
      extraEnv.NPM_AUTH = env.NPM_AUTH;
      extraEnv.NPM_EMAIL = env.NPM_EMAIL;
    }
    const commands: string[] = [];

    cmd = 'pnpm';
    let args = 'install --recursive --lockfile-only';
    if (!GlobalConfig.get('allowScripts') || config.ignoreScripts) {
      args += ' --ignore-scripts';
      args += ' --ignore-pnpmfile';
    }
    logger.trace({ cmd, args }, 'pnpm command');
    commands.push(`${cmd} ${args}`);

    // postUpdateOptions
    if (config.postUpdateOptions?.includes('pnpmDedupe')) {
      logger.debug('Performing pnpm dedupe');
      commands.push('pnpm dedupe');
    }

    if (upgrades.find((upgrade) => upgrade.isLockFileMaintenance)) {
      logger.debug(
        `Removing ${lockFileName} first due to lock file maintenance upgrade`
      );
      try {
        await deleteLocalFile(lockFileName);
      } catch (err) /* istanbul ignore next */ {
        logger.debug(
          { err, lockFileName },
          'Error removing yarn.lock for lock file maintenance'
        );
      }
    }

    await exec(commands, execOptions);
    lockFile = await readLocalFile(lockFileName, 'utf8');
  } catch (err) /* istanbul ignore next */ {
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug(
      {
        cmd,
        err,
        stdout,
        stderr,
        type: 'pnpm',
      },
      'lock file error'
    );
    return { error: true, stderr: err.stderr, stdout: err.stdout };
  }
  return { lockFile };
}

async function getPnpmConstraint(
  lockFileDir: string
): Promise<string | undefined> {
  let result: string | undefined;
  const rootPackageJson = upath.join(lockFileDir, 'package.json');
  const content = await readLocalFile(rootPackageJson, 'utf8');
  if (content) {
    const packageJson: NpmPackage = JSON.parse(content);
    const packageManager = packageJson?.packageManager;
    if (packageManager?.includes('@')) {
      const nameAndVersion = packageManager.split('@');
      const name = nameAndVersion[0];
      if (name === 'pnpm') {
        result = nameAndVersion[1];
      }
    } else {
      const engines = packageJson?.engines;
      if (engines) {
        result = engines['pnpm'];
      }
    }
  }
  if (!result) {
    const lockFileName = upath.join(lockFileDir, 'pnpm-lock.yaml');
    const content = await readLocalFile(lockFileName, 'utf8');
    if (content) {
      const pnpmLock = load(content) as PnpmLockFile;
      if (
        is.number(pnpmLock.lockfileVersion) &&
        pnpmLock.lockfileVersion < 5.4
      ) {
        result = '<7';
      }
    }
  }
  return result;
}
