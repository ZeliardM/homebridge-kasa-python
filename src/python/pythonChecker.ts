import type { Logger } from 'homebridge';

import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type KasaPythonPlatform from '../platform.js';
import { delay, prefixLogger, runCommand } from '../utils.js';

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));
const SUPPORTED_PYTHON_VERSIONS: string[] = ['3.11', '3.12', '3.13'];

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

  public constructor(platform: KasaPythonPlatform) {
    this.platform = platform;
    this.log = prefixLogger(this.platform.log, '[Python Check]');
    this.pythonExecutable = 'python3';
    this.pluginDirPath = path.join(this.platform.storagePath, 'kasa-python');
    this.venvPath = path.join(this.pluginDirPath, '.venv');
    this.venvPythonExecutable = path.join(this.venvPath, 'bin', 'python3');
    this.venvPipExecutable = path.join(this.venvPath, 'bin', 'pip3');
    this.venvConfigPath = path.join(this.venvPath, 'pyvenv.cfg');
  }

  public async allInOne(isUpgrade: boolean): Promise<void> {
    this.log.debug('Starting python environment check...');
    this.ensurePluginDir();
    await this.ensurePythonVersion();
    await this.ensureVenvCreated(isUpgrade);
    await this.ensureVenvUsesCorrectPythonHome();
    await this.ensureVenvPipUpToDate();
    await this.ensureVenvRequirementsSatisfied();
    this.log.debug('Finished python environment check.');
  }

  private ensurePluginDir(): void {
    if (!fs.existsSync(this.pluginDirPath)) {
      fs.mkdirSync(this.pluginDirPath);
    }
  }

  private async ensurePythonVersion(): Promise<void> {
    const version: string = await this.getSystemPythonVersion();
    if (SUPPORTED_PYTHON_VERSIONS.findIndex((e) => version.includes(e)) === -1) {
      while (true) {
        this.log.error(`Python ${version} is installed. However, only Python ${SUPPORTED_PYTHON_VERSIONS.join(', ')} is supported.`);
        await delay(300000);
      }
    }
  }

  private async ensureVenvCreated(isUpgrade: boolean): Promise<void> {
    if (isUpgrade || !this.isVenvCreated()) {
      await this.createVenv();
    }
  }

  private isVenvCreated(): boolean {
    return fs.existsSync(this.venvPipExecutable) && fs.existsSync(this.venvConfigPath) && fs.existsSync(this.venvPythonExecutable);
  }

  private async createVenv(): Promise<void> {
    const [stdout] = await runCommand(this.log, this.pythonExecutable, ['-m', 'venv', this.venvPath, '--clear'], undefined, true);
    if (stdout.includes('not created successfully') || !this.isVenvCreated()) {
      while (true) {
        this.log.error('virtualenv python module is not installed.');
        await delay(300000);
      }
    }
  }

  private async ensureVenvUsesCorrectPythonHome(): Promise<void> {
    const venvPythonHome: string = await this.getPythonHome(this.venvPythonExecutable);
    const pythonHome: string = await this.getPythonHome(this.pythonExecutable);
    if (venvPythonHome !== pythonHome) {
      await this.createVenv();
    }
  }

  private async getPythonHome(executable: string): Promise<string> {
    const [venvPythonHome] = await runCommand(this.log, executable, [path.join(__dirname, 'pythonHome.py')], undefined, true);
    return venvPythonHome.trim();
  }

  private async ensureVenvPipUpToDate(): Promise<void> {
    const venvPipVersion: string = await this.getVenvPipVersion();
    if (venvPipVersion !== await this.getMostRecentPipVersion()) {
      await this.updatePip();
    }
  }

  private async updatePip(): Promise<void> {
    await runCommand(this.log, this.venvPipExecutable, ['install', '--upgrade', 'pip'], undefined, true);
  }

  private async ensureVenvRequirementsSatisfied(): Promise<void> {
    if (!await this.areRequirementsSatisfied()) {
      await this.installRequirements();
    }
  }

  private async areRequirementsSatisfied(): Promise<boolean> {
    const [freezeStdout] = await runCommand(this.log, this.venvPipExecutable, ['freeze'], undefined, true);
    const freeze = this.freezeStringToObject(freezeStdout);
    const requirements = this.freezeStringToObject(fs.readFileSync(this.requirementsPath).toString());
    return Object.keys(requirements).every(pkg => freeze[pkg] === requirements[pkg]);
  }

  private freezeStringToObject(value: string): Record<string, string> {
    return value.trim().split('\n').reduce<Record<string, string>>((acc, line) => {
      const [pkg, version] = line.split('==');
      acc[pkg.replaceAll('_', '-')] = version;
      return acc;
    }, {});
  }

  private async installRequirements(): Promise<void> {
    await runCommand(this.log, this.venvPipExecutable, ['install', '-r', this.requirementsPath], undefined, true);
  }

  private async getSystemPythonVersion(): Promise<string> {
    const [version] = await runCommand(this.log, this.pythonExecutable, ['--version'], undefined, true);
    return version.trim().replace('Python ', '');
  }

  private async getVenvPipVersion(): Promise<string> {
    const [version] = await runCommand(this.log, this.venvPipExecutable, ['--version'], undefined, true);
    return version.trim().split(' ')[1];
  }

  private async getMostRecentPipVersion(): Promise<string> {
    try {
      const response = await axios.get<{ info: { version: string } }>('https://pypi.org/pypi/pip/json');
      return response.data.info.version;
    } catch (e) {
      this.log.error(e as string);
      return 'error';
    }
  }
}

export default PythonChecker;