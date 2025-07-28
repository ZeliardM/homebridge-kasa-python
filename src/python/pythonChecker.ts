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
  private readonly advancedPythonLogging: boolean;
  private readonly pythonExecutables: string[];
  private readonly pluginDirPath: string;
  private readonly venvPath: string;
  private readonly venvConfigPath: string;
  private readonly requirementsPath: string = path.join(__dirname, '..', '..', 'requirements.txt');
  private pythonExecutable: string = '';
  private venvPipExecutable: string = '';
  private venvPythonExecutable: string = '';
  private userPath: string = '';

  public constructor(platform: KasaPythonPlatform) {
    this.platform = platform;
    this.log = prefixLogger(this.platform.log, '[Python Check]');
    this.advancedPythonLogging = this.platform.config.advancedOptions?.advancedPythonLogging ?? false;

    this.pythonExecutables = [
      'python3',
      'python3.11',
      'python3.12',
      'python3.13',
      'python3.14',
      '/usr/bin/python3',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      `${process.env.HOME}/miniforge3/bin/python3`,
      `${process.env.HOME}/miniconda3/bin/python3`,
    ];

    this.pluginDirPath = path.join(this.platform.storagePath, 'kasa-python');
    this.venvPath = path.join(this.pluginDirPath, '.venv');
    this.venvConfigPath = path.join(this.venvPath, 'pyvenv.cfg');
  }

  public async allInOne(isUpgrade: boolean): Promise<void> {
    this.log.debug('Starting python environment check...');
    this.userPath = await this.getUserPath();
    this.platform.userPath = this.userPath;
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
    this.log.debug('Checking for supported Python version');
    const userPythonPath = this.platform.config.advancedOptions.pythonPath ?? '';
    if (userPythonPath) {
      this.log.debug(`User configured pythonPath: ${userPythonPath}`);
      if (await this.isPythonSupported(userPythonPath)) {
        this.setPythonExecutables(userPythonPath);
        return;
      } else {
        this.log.error(`Configured pythonPath (${userPythonPath}) is not supported`);
      }
    }
    for (const executable of this.pythonExecutables) {
      if (await this.isPythonSupported(executable)) {
        this.setPythonExecutables(executable);
        return;
      }
    }
    const fallback = '/usr/bin/python3';
    this.log.warn(`Falling back to system Python: ${fallback}`);
    if (await this.isPythonSupported(fallback)) {
      this.setPythonExecutables(fallback);
    } else {
      this.log.error(`System Python (${fallback}) is unsupported`);
      throw new Error('No supported Python version found. Install Python 3.11+ and restart Homebridge.');
    }
  }

  private setPythonExecutables(pythonPath: string): void {
    const majorMinor = this.getPythonMajorMinor(pythonPath);
    const pipName = `pip${majorMinor}`;
    const pyName = `python${majorMinor}`;

    this.pythonExecutable = pythonPath;
    this.venvPythonExecutable = path.join(this.venvPath, 'bin', pyName);
    this.venvPipExecutable = path.join(this.venvPath, 'bin', pipName);

    this.log.debug(`Selected Python executable: ${this.pythonExecutable}`);
  }

  private async isPythonSupported(executable: string): Promise<boolean> {
    try {
      const [stdout] = await runCommand(
        this.log,
        executable,
        ['--version'],
        undefined,
        false,
        true,
        false,
        ['ENOENT'],
      );
      const version = stdout.trim().replace('Python ', '');
      const majorMinor = version.split('.').slice(0, 2).join('.');
      this.log.debug(`Detected Python version ${version} at ${executable}`);
      return SUPPORTED_PYTHON_VERSIONS.includes(majorMinor);
    } catch (err) {
      this.log.error(`Failed to check Python version for ${executable}: ${err}`);
      return false;
    }
  }

  private getPythonMajorMinor(pythonPath: string): string {
    const match = pythonPath.match(/python(?:3)?\.(\d+)\.(\d+)/);
    if (match) {
      return `${match[1]}.${match[2]}`;
    }
    return '3';
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
    const [stdout] = await runCommand(
      this.log,
      this.pythonExecutable,
      ['-m', 'venv', this.venvPath, '--clear', '--upgrade-deps'],
      { env: { ...process.env, PATH: this.userPath } },
      !this.advancedPythonLogging,
      !this.advancedPythonLogging,
    );
    if (stdout.includes('not created successfully') || !this.isVenvCreated()) {
      this.log.error('Failed to create virtual environment.');
      await delay(300000);
    } else {
      this.log.debug('Virtual environment created successfully');
    }
  }

  private async ensureVenvUsesCorrectPythonHome(): Promise<void> {
    this.log.debug('Ensuring virtual environment uses correct Python home');
    const venvPythonHome = await this.getPythonHome(this.venvPythonExecutable);
    const pythonHome = await this.getPythonHome(this.pythonExecutable);
    if (venvPythonHome !== pythonHome) {
      this.log.debug('Python homes mismatch, recreating virtual environment');
      await this.createVenv();
    } else {
      this.log.debug('Python homes match');
    }
  }

  private async getPythonHome(executable: string): Promise<string> {
    this.log.debug('Getting Python home for executable:', executable);
    const [venvPythonHome] = await runCommand(
      this.log,
      executable,
      [path.join(__dirname, 'pythonHome.py')],
      { env: { ...process.env, PATH: this.userPath } },
      !this.advancedPythonLogging,
      !this.advancedPythonLogging,
    );
    return venvPythonHome.trim();
  }

  private async getUserPath(): Promise<string> {
    this.log.debug('Attempting to retrieve user PATH');
    const shells = ['/bin/zsh', '/bin/bash'];
    const brewExists = fs.existsSync('/opt/homebrew/bin/brew') || fs.existsSync('/usr/local/bin/brew');
    for (const shell of shells) {
      if (fs.existsSync(shell)) {
        const shellCommands = [];
        if (brewExists) {
          shellCommands.push('eval "$(brew shellenv)" 2>/dev/null');
        }
        shellCommands.push(
          'source ~/.zprofile 2>/dev/null',
          'source ~/.bash_profile 2>/dev/null',
          'source ~/.profile 2>/dev/null',
          'echo $PATH',
        );
        let shellArgs: string[];
        if (shell.endsWith('zsh')) {
          shellArgs = ['-f', '-c', shellCommands.join(' && ')];
        } else {
          shellArgs = ['--noprofile', '--norc', '-c', shellCommands.join(' && ')];
        }
        try {
          const [stdout] = await runCommand(
            this.log,
            shell,
            shellArgs,
            undefined,
            false,
            true,
          );
          const userPath = stdout.trim();
          if (userPath) {
            this.log.debug('User PATH retrieved:', userPath);
            return userPath;
          }
        } catch (err) {
          this.log.error(`Failed to retrieve PATH from ${shell}: ${err}`);
        }
      }
    }
    this.log.debug('Falling back to process.env.PATH');
    return process.env.PATH ?? '';
  }

  private async ensureVenvPipUpToDate(): Promise<void> {
    const currentVersion = await this.getVenvPipVersion();
    const latestVersion = await this.getMostRecentPipVersion();
    if (currentVersion !== latestVersion) {
      await this.updatePip();
    } else {
      this.log.debug('Virtual environment pip is up to date');
    }
  }

  private async updatePip(): Promise<void> {
    this.log.debug('Updating pip in virtual environment');
    await runCommand(
      this.log,
      this.venvPipExecutable,
      ['install', '--upgrade', 'pip'],
      { env: { ...process.env, PATH: this.userPath } },
      !this.advancedPythonLogging,
      !this.advancedPythonLogging,
    );
    this.log.debug('Pip updated successfully');
  }

  private async ensureVenvRequirementsSatisfied(): Promise<void> {
    if (!await this.areRequirementsSatisfied()) {
      await this.installRequirements();
    } else {
      this.log.debug('Virtual environment requirements are satisfied');
    }
  }

  private async areRequirementsSatisfied(): Promise<boolean> {
    const [freezeStdout] = await runCommand(
      this.log,
      this.venvPipExecutable,
      ['freeze'],
      { env: { ...process.env, PATH: this.userPath } },
      !this.advancedPythonLogging,
      !this.advancedPythonLogging,
    );
    const installed = this.stringToObject(freezeStdout);
    const required = this.stringToObject(fs.readFileSync(this.requirementsPath, 'utf8'));
    return Object.keys(required).every(pkg => installed[pkg] === required[pkg]);
  }

  private stringToObject(value: string): Record<string, string> {
    return value.trim().split('\n').reduce((acc, line) => {
      const [pkg, version] = line.split('==').map(x => x.trim());
      if (pkg && version) {
        acc[pkg.toLowerCase()] = version;
      }
      return acc;
    }, {} as Record<string, string>);
  }

  private async installRequirements(): Promise<void> {
    this.log.debug('Installing requirements from:', this.requirementsPath);
    await runCommand(
      this.log,
      this.venvPipExecutable,
      ['install', '-r', this.requirementsPath],
      { env: { ...process.env, PATH: this.userPath } },
      !this.advancedPythonLogging,
      !this.advancedPythonLogging,
    );
    this.log.debug('Requirements installed successfully');
  }

  private async getVenvPipVersion(): Promise<string> {
    const [stdout] = await runCommand(
      this.log,
      this.venvPipExecutable,
      ['--version'],
      { env: { ...process.env, PATH: this.userPath } },
      !this.advancedPythonLogging,
      !this.advancedPythonLogging,
    );
    return stdout.trim().split(' ')[1];
  }

  private async getMostRecentPipVersion(): Promise<string> {
    try {
      const response = await axios.get<{ info: { version: string } }>('https://pypi.org/pypi/pip/json');
      return response.data.info.version;
    } catch (err) {
      this.log.error(`Error fetching latest pip version: ${err}`);
      return '';
    }
  }
}

export default PythonChecker;