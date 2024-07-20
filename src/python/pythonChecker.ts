import axios from 'axios';
import type { AxiosResponse } from 'axios';
import chalk from 'chalk';
import fs from 'fs';
import type { Logger } from 'homebridge';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type KasaPythonPlatform from '../platform.js';
import { delay, prefixLogger, runCommand } from '../utils.js';

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));

const SUPPORTED_PYTHON_VERSIONS: string[] = [
  '3.9',
  '3.10',
  '3.11',
  '3.12',
];

class PythonChecker {
  private readonly log: Logger;
  private readonly platform: KasaPythonPlatform;

  private readonly pythonExecutable: string;
  private readonly pluginDirPath: string;
  private readonly venvPath: string;
  private readonly venvPipExecutable: string;
  private readonly venvPythonExecutable: string;
  private readonly venvConfigPath: string;
  private readonly requirementsPath: string = path.join(__dirname, '..', '..', 'requirements.txt');

  public constructor(platform: KasaPythonPlatform, storagePath: string, pythonExecutable?: string) {
    this.platform = platform;
    this.log = prefixLogger(
      this.platform.log,
      () => `${chalk.blue('[Python Check]')}`,
    );

    this.pythonExecutable = pythonExecutable || 'python3';
    this.log.debug(`Using ${this.pythonExecutable} as the python executable`);

    this.pluginDirPath = path.join(storagePath, 'kasa-python');
    this.venvPath = path.join(this.pluginDirPath, '.venv');
    this.venvPythonExecutable = path.join(this.venvPath, 'bin', 'python3');
    this.venvPipExecutable = path.join(this.venvPath, 'bin', 'pip3');
    this.venvConfigPath = path.join(this.venvPath, 'pyvenv.cfg');
  }

  public async allInOne(forceVenvRecreate: boolean = false): Promise<void> {
    this.log.info('Starting python evironment check...');
    this.ensurePluginDir();
    await this.ensurePythonVersion();
    await this.ensureVenvCreated(forceVenvRecreate);
    await this.ensureVenvUsesCorrectPythonHome();
    await this.ensureVenvPipUpToDate();
    await this.ensureVenvRequirementsSatisfied();
    this.log.info('Finished python environment check.');
  }

  private ensurePluginDir(): void {
    this.log.debug('Checking if plugin directory exists...');
    if (!fs.existsSync(this.pluginDirPath)) {
      this.log.debug('Plugin directory does not exist, Creating plugin dir...');
      fs.mkdirSync(this.pluginDirPath);
      this.log.debug('Plugin directory created. Continuing...');
    } else {
      this.log.debug('Plugin directory already exists. Continuing...');
    }
  }

  private async ensurePythonVersion(): Promise<void> {
    this.log.debug('Getting python version...');
    const version: string = await this.getSystemPythonVersion();
    if (SUPPORTED_PYTHON_VERSIONS.findIndex((e) => version.includes(e)) === -1) {
      while (true) {
        this.log.error(`Python ${version} is installed. However, only Python \
          ${SUPPORTED_PYTHON_VERSIONS[0]} to ${SUPPORTED_PYTHON_VERSIONS[SUPPORTED_PYTHON_VERSIONS.length - 1]} is supported.`);
        await delay(300000);
      }
    } else {
      this.log.debug(`Python ${version} is installed and supported by the plugin. Continuing...`);
    }
  }

  private async ensureVenvCreated(forceVenvRecreate: boolean): Promise<void> {
    this.log.debug('Checking if python virtual environment exists...');
    if (forceVenvRecreate) {
      this.log.warn('Python virtual environment is being force recreated...');
      await this.createVenv();
    } else if (this.isVenvCreated() === false) {
      this.log.info('Python virtual environment does not exist. Creating now...');
      await this.createVenv();
    } else {
      this.log.info('Python virtual environment already exists. Continuing...');
    }
  }

  private isVenvCreated(): boolean {
    return fs.existsSync(this.venvPipExecutable) &&
      fs.existsSync(this.venvConfigPath) &&
      fs.existsSync(this.venvPythonExecutable);
  }

  private async createVenv(): Promise<void> {
    const [stdout]: [string, string, number | null] =
      await runCommand(this.log, this.pythonExecutable, ['-m', 'venv', this.venvPath, '--clear'], undefined, true);
    if (stdout.includes('not created successfully') || !this.isVenvCreated()) {
      while (true) {
        this.log.error('virtualenv python module is not installed. If you have installed homebridge via the apt package manager, \
          update the homebridge apt package to 1.1.4 or above (this applies for installations based on the Raspberry Pi OS iamge as well). \
          When using the official docker image, update the image to version 2023-11-28 or above. Otherwise install the python virtualenv \
          module manually.');
        await delay(300000);
      }
    } else if (stdout.trim() !== '') {
      this.log.warn(stdout);
    }
    this.log.debug('Python virtual environment (re)created. Continuing...');
  }

  private async ensureVenvUsesCorrectPythonHome(): Promise<void> {
    this.log.debug('Checking if python virtual environment uses the python system environment...');
    this.log.debug('Getting python home for python virtual environment...');
    const venvPythonHome: string = await this.getPythonHome(this.venvPythonExecutable);
    this.log.debug('Getting python home for python system environment...');
    const pythonHome: string = await this.getPythonHome(this.pythonExecutable);
    if (venvPythonHome !== pythonHome) {
      this.log.warn('Python virtual environment does not use the python system environment.\
        Recreating virtual environment...');
      this.log.debug(`Python System Environment: ${pythonHome}; Python Virtual Environment: ${venvPythonHome}`);
      await this.createVenv();
    } else {
      this.log.debug('Python virtual environment is using the python system environment. Continuing ...');
    }
  }

  private async getPythonHome(executable: string): Promise<string> {
    const [venvPythonHome]: [string, string, number | null] =
      await runCommand(this.log, executable, [path.join(__dirname, 'pythonHome.py')], undefined, true);
    return venvPythonHome.trim();
  }

  private async ensureVenvPipUpToDate(): Promise<void> {
    this.log.debug('Checking if python virtual environment pip is up-to-date...');
    const venvPipVersion: string = await this.getVenvPipVersion();
    this.log.debug(`Python virtual environment pip version: ${venvPipVersion}`);
    this.log.debug('Checking if there is an update for python virtual environment pip...');
    if (venvPipVersion === await this.getMostRecentPipVersion()) {
      this.log.debug('Python virtual environment pip is up-to-date. Continuing...');
    } else {
      this.log.warn('Python virtual environment pip is outdated. Updating now...');
      await this.updatePip();
      this.log.debug('Python virtual environment pip updated. Continuing...');
    }
  }

  private async updatePip(): Promise<void> {
    await runCommand(this.log, this.venvPipExecutable, ['install', '--upgrade', 'pip'], undefined, true);
  }

  private async ensureVenvRequirementsSatisfied(): Promise<void> {
    if (await this.areRequirementsSatisfied()) {
      this.log.debug('Python requirements are satisfied. Continuing...');
    } else {
      this.log.warn('Python requirements are not satisfied. Installing them now...');
      await this.installRequirements();
    }
  }

  private async areRequirementsSatisfied(): Promise<boolean> {
    const [freezeStdout]: [string, string, number | null] =
      await runCommand(this.log, this.venvPipExecutable, ['freeze'], undefined, true);
    const freeze: Record<string, string> = this.freezeStringToObject(freezeStdout);
    const requirements: Record<string, string> = this.freezeStringToObject(fs.readFileSync(this.requirementsPath).toString());
    for (const pkg in requirements) {
      if (freeze[pkg] !== requirements[pkg]) {
        return false;
      }
    }
    return true;
  }

  private freezeStringToObject(value: string): Record<string, string> {
    const lines: string[] = value.trim().split('\n');
    const packages: Record<string, string> = {};
    for (const line of lines) {
      const [pkg, version]: string[] = line.split('==');
      packages[pkg.replaceAll('_', '-')] = version;
    }
    return packages;
  }

  private async installRequirements(): Promise<void> {
    await runCommand(this.log, this.venvPipExecutable, ['install', '-r', this.requirementsPath], undefined, true);
    this.log.debug('Python requirements installed. Continuing...');
  }

  private async getSystemPythonVersion(): Promise<string> {
    const [version]: [string, string, number | null] =
      await runCommand(this.log, this.pythonExecutable, ['--version'], undefined, true);
    return version.trim().replace('Python ', '');
  }

  private async getVenvPipVersion(): Promise<string> {
    const [version]: [string, string, number | null] =
      await runCommand(this.log, this.venvPipExecutable, ['--version'], undefined, true);
    return version.trim().replace('pip ', '').split(' ')[0];
  }

  private async getMostRecentPipVersion(): Promise<string> {
    try {
      const response: AxiosResponse<{ info: { version: string } }, unknown> = await axios.get('https://pypi.org/pypi/pip/json');
      return response.data.info.version;
    } catch (e) {
      this.log.error(e as string);
      return 'error';
    }
  }
}

export default PythonChecker;