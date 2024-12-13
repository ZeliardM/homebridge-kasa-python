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
    this.log.debug('Python environment check completed successfully');
  }

  private ensurePluginDir(): void {
    this.log.debug('Ensuring plugin directory exists:', this.pluginDirPath);
    if (!fs.existsSync(this.pluginDirPath)) {
      fs.mkdirSync(this.pluginDirPath);
      this.log.debug('Plugin directory created:', this.pluginDirPath);
    } else {
      this.log.debug('Plugin directory already exists:', this.pluginDirPath);
    }
  }

  private async ensurePythonVersion(): Promise<void> {
    this.log.debug('Ensuring system Python version is supported');
    const version: string = await this.getSystemPythonVersion();
    if (!SUPPORTED_PYTHON_VERSIONS.some(e => version.includes(e))) {
      this.log.error(`Python ${version} is installed. However, only Python ${SUPPORTED_PYTHON_VERSIONS.join(', ')} is supported.`);
      await delay(300000);
    } else {
      this.log.debug('System Python version is supported');
    }
  }

  private async ensureVenvCreated(isUpgrade: boolean): Promise<void> {
    this.log.debug('Ensuring virtual environment is created');
    if (isUpgrade || !this.isVenvCreated()) {
      await this.createVenv();
    } else {
      this.log.debug('Virtual environment already exists');
    }
  }

  private isVenvCreated(): boolean {
    const venvExists = fs.existsSync(this.venvPipExecutable) &&
      fs.existsSync(this.venvConfigPath) &&
      fs.existsSync(this.venvPythonExecutable);
    this.log.debug('Virtual environment exists:', venvExists);
    return venvExists;
  }

  private async createVenv(): Promise<void> {
    this.log.debug('Creating virtual environment at path:', this.venvPath);
    const [stdout] = await runCommand(this.log, this.pythonExecutable, ['-m', 'venv', this.venvPath, '--clear'], undefined, true);
    if (stdout.includes('not created successfully') || !this.isVenvCreated()) {
      this.log.error('virtualenv python module is not installed.');
      await delay(300000);
    } else {
      this.log.debug('Virtual environment created successfully');
    }
  }

  private async ensureVenvUsesCorrectPythonHome(): Promise<void> {
    this.log.debug('Ensuring virtual environment uses correct Python home');
    const venvPythonHome: string = await this.getPythonHome(this.venvPythonExecutable);
    const pythonHome: string = await this.getPythonHome(this.pythonExecutable);
    this.log.debug('Virtual environment Python home:', venvPythonHome);
    this.log.debug('System Python home:', pythonHome);
    if (venvPythonHome !== pythonHome) {
      this.log.debug('Python homes do not match, recreating virtual environment');
      await this.createVenv();
    } else {
      this.log.debug('Python homes match');
    }
  }

  private async getPythonHome(executable: string): Promise<string> {
    this.log.debug('Getting Python home for executable:', executable);
    const [venvPythonHome] = await runCommand(this.log, executable, [path.join(__dirname, 'pythonHome.py')], undefined, true);
    return venvPythonHome.trim();
  }

  private async ensureVenvPipUpToDate(): Promise<void> {
    this.log.debug('Ensuring virtual environment pip is up to date');
    const venvPipVersion: string = await this.getVenvPipVersion();
    const mostRecentPipVersion = await this.getMostRecentPipVersion();
    if (venvPipVersion !== mostRecentPipVersion) {
      await this.updatePip();
    } else {
      this.log.debug('Virtual environment pip is up to date');
    }
  }

  private async updatePip(): Promise<void> {
    this.log.debug('Updating pip in virtual environment');
    await runCommand(this.log, this.venvPipExecutable, ['install', '--upgrade', 'pip'], undefined, true);
    this.log.debug('Pip updated successfully');
  }

  private async ensureVenvRequirementsSatisfied(): Promise<void> {
    if (!await this.areRequirementsSatisfied()) {
      await this.installRequirements();
    } else {
      this.log.debug('Virtual environment requirements are already satisfied');
    }
  }

  private async areRequirementsSatisfied(): Promise<boolean> {
    this.log.debug('Checking if virtual environment requirements are satisfied');
    const [freezeStdout] = await runCommand(this.log, this.venvPipExecutable, ['freeze'], undefined, true);
    const freeze = this.stringToObject(freezeStdout);
    this.log.debug('Current virtual environment packages:', JSON.stringify(freeze, null, 2));
    const requirementsStdout = fs.readFileSync(this.requirementsPath).toString();
    const requirements = this.stringToObject(requirementsStdout);
    this.log.debug('Required packages:', JSON.stringify(requirements, null, 2));
    const requirementsSatisfied = Object.keys(requirements).every(pkg => freeze[pkg] === requirements[pkg]);
    this.log.debug('Requirements satisfied:', requirementsSatisfied);
    return requirementsSatisfied;
  }

  private stringToObject(value: string): Record<string, string> {
    return value.trim().split('\n').reduce<Record<string, string>>((acc, line) => {
      const [pkg, version] = line.split('==').map(part => part.trim());
      acc[pkg.replaceAll('_', '-').toLowerCase()] = version;
      return acc;
    }, {});
  }

  private async installRequirements(): Promise<void> {
    this.log.debug('Installing requirements from:', this.requirementsPath);
    await runCommand(this.log, this.venvPipExecutable, ['install', '-r', this.requirementsPath], undefined, true);
    this.log.debug('Requirements installed successfully');
  }

  private async getSystemPythonVersion(): Promise<string> {
    this.log.debug('Getting system Python version');
    const [version] = await runCommand(this.log, this.pythonExecutable, ['--version'], undefined, true);
    this.log.debug('System Python version:', version.trim().replace('Python ', ''));
    return version.trim().replace('Python ', '');
  }

  private async getVenvPipVersion(): Promise<string> {
    this.log.debug('Getting virtual environment pip version');
    const [version] = await runCommand(this.log, this.venvPipExecutable, ['--version'], undefined, true);
    this.log.debug('Virtual environment pip version:', version.trim().split(' ')[1]);
    return version.trim().split(' ')[1];
  }

  private async getMostRecentPipVersion(): Promise<string> {
    this.log.debug('Fetching most recent pip version from PyPI');
    try {
      const response = await axios.get<{ info: { version: string } }>('https://pypi.org/pypi/pip/json');
      this.log.debug('Most recent pip version fetched:', response.data.info.version);
      return response.data.info.version;
    } catch (e) {
      this.log.error(`Error fetching most recent pip version: ${e}`);
      return 'error';
    }
  }
}

export default PythonChecker;